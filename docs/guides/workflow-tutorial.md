# Workflow tutorial

This walks a single object from "no state machine" to a guarded, auditable lifecycle — and then
through a safe definition change. It assumes a WeaveKit project (`npm create weavekit-app`) with a
reachable PostgreSQL (`DATABASE_URL`).

## 1. Turn a workflow on

```bash
weave object:create order            # id + title, no state machine
weave workflow:open order            # scaffolds a starter machine
```

`workflow:open` does three things:

- sets `"workflowEnabled": true` in `objects/order/schema.json`;
- adds a `status` `enum` field (`draft`, `pending`, `approved`, `archived`) unless you point it at an
  existing enum with `--state-field <field>`;
- writes `objects/order/workflow.json` with a starter lifecycle.

Prefer to reuse an existing enum? Pass it explicitly:

```bash
weave workflow:open order --state-field stage --states open,in_review,closed
```

(With `--state-field`, the state names must already be options of that enum; without `--states` the
whole option list is used, which keeps existing rows valid.)

## 2. Read the generated files

`objects/order/schema.json`:

```json
{
  "name": "order",
  "workflowEnabled": true,
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "title", "type": "string", "required": true },
    { "name": "status", "type": "enum", "options": ["draft", "pending", "approved", "archived"] }
  ]
}
```

`objects/order/workflow.json`:

```json
{
  "schemaVersion": 1,
  "stateField": "status",
  "initial": "draft",
  "states": [
    { "name": "draft", "labels": { "en": "Draft" } },
    { "name": "pending", "labels": { "en": "Pending" } },
    { "name": "approved", "labels": { "en": "Approved" } },
    { "name": "archived", "labels": { "en": "Archived" } }
  ],
  "transitions": [
    { "action": "submit", "from": "draft", "to": "pending", "labels": { "en": "Submit" } },
    { "action": "approve", "from": "pending", "to": "approved", "labels": { "en": "Approve" } },
    { "action": "reject", "from": "pending", "to": "draft", "labels": { "en": "Reject" } },
    { "action": "archive", "from": "approved", "to": "archived", "labels": { "en": "Archive" } },
    { "action": "reopen", "from": "archived", "to": "draft", "labels": { "en": "Reopen" } }
  ]
}
```

`stateField` must name the single-valued `enum` field; its options must list every state. New records
start in `initial`. The state field is engine-managed: it is read-only except through a transition.

## 3. Migrate (and backfill)

```bash
weave migrate
```

If `workflow:open` added the `status` field to an object that already has rows, those rows have no
state yet — backfill them to the initial state:

```sql
UPDATE "order" SET "status" = 'draft' WHERE "status" IS NULL;
```

When you reuse an existing enum field, no DDL or backfill is needed.

## 4. Inspect a record's workflow

```bash
weave dev
```

```bash
curl -H "Authorization: Bearer sk-admin" \
  http://localhost:3000/api/objects/order/O1/workflow
# { "state": "draft", "initial": "draft",
#   "actions": [{ "action": "submit", "to": "pending", "labels": { "en": "Submit" } }] }
```

`actions` lists only the transitions fireable from the current state by the caller's roles — ready to
render as buttons.

## 5. Fire a transition

```bash
curl -X POST -H "Authorization: Bearer sk-admin" \
  http://localhost:3000/api/objects/order/O1/transitions/submit
```

Every transition is recorded as a `transition` audit event (with `action`, `from`, `to` and the
definition identity) and published on the live channel as `record.transitioned`. Writing `status`
directly (`PATCH`) fails with `400 workflow.transition.required`.

## 6. From an agent (MCP)

```jsonc
// tool call
{ "name": "workflow_transition", "arguments": { "object": "order", "id": "O1", "action": "approve" } }
```

The tool only appears for objects with an active workflow and identities allowed to update them.

## 7. From the client SDK

```ts
import { createClient } from '@weave-kit/client';

const client = createClient({ baseUrl: 'http://localhost:3000', apiKey: 'sk-admin' });

const { state, actions } = await client.workflow.get('order', 'O1');
await client.workflow.transition('order', 'O1', 'submit');

// react to live changes
client.subscribe({ object: 'order' }, (event) => {
  if (event.type === 'record.transitioned') console.log(event.payload.from, '→', event.payload.to);
});
```

## 8. Add a role gate and an approval

Restrict a transition to a role:

```json
{ "action": "approve", "from": "pending", "to": "approved", "roles": ["manager"] }
```

Hold a transition for human approval:

```json
{ "action": "publish", "from": "approved", "to": "published", "requiresApproval": true }
```

A caller now gets `409 workflow.transition.pending` with an `approvalKey`; an admin approves through
the [approval queue](approvals.md), then the caller retries the same transition. With the
[open contract](custom-tools-and-guardrails.md) enabled, guardrail policies can also deny or require
approval per transition (they see `ctx.action = workflow.transition.<object>.<action>`).

## 9. Add a timeout

A state can expire — the clock starts when a record enters it:

```json
{ "name": "pending", "onTimeout": { "after": "7d", "action": "reject" } }
```

The durable scheduler is opt-in:

```bash
weave module:add workflow
```

Timers live in PostgreSQL (`weavekit_workflow_timers`, claimed with `FOR UPDATE SKIP LOCKED`, so
multiple instances never double-fire). On expiry the engine dispatches the `onTimeout` script hook
(if any) and then fires the declared action. Leaving the state — or deleting the record — cancels the
timer.

## 10. React in code

With the [script subsystem](script-hooks.md) enabled, `objects/order/server.js` can observe the
lifecycle:

```js
export function onEnter() {
  if (this.state === 'approved') this.changes.approved_at = new Date().toISOString();
  return this.changes;
}
```

| Hook | When | `this` |
| --- | --- | --- |
| `beforeTransition` | inside the transaction, before the write | `this.transition` (`{ from, to }`), `this.state` (target) |
| `afterTransition` | after commit | `this.transition`, `this.state` |
| `onExit` / `onEnter` | after commit, leaving / entering a state | `this.state` |
| `onTimeout` | when a state timeout fires | `this.state` |

## 11. Evolve the machine safely

Bump the author-managed revision so history is attributable, and remap any removed state:

```json
{
  "version": 2,
  "stateField": "status",
  "initial": "pending",
  "states": [{ "name": "pending" }, { "name": "approved" }, { "name": "archived" }],
  "transitions": [
    { "action": "approve", "from": "pending", "to": "approved" },
    { "action": "archive", "from": "approved", "to": "archived" }
  ],
  "migrations": [{ "from": "draft", "to": "pending" }]
}
```

```bash
weave workflow:migrate order --dry-run   # report what would move
weave workflow:migrate order             # UPDATE "order" SET "status"='pending' WHERE "status"='draft'
```

`workflow:migrate` reports any record left in an orphan state (not declared and not remapped) as a
warning, and writes a `workflow.migrated` audit event. The enum option for the old state is left in
place, so no destructive DDL is required. `version` and the definition's semantic hash are surfaced
in the descriptor and in every transition event/audit.

`workflow.json` also has an on-disk format version (`schemaVersion`), handled separately:

```bash
weave workflow:upgrade --dry-run
weave workflow:upgrade
```

## 12. Turn it off

```bash
weave workflow:close order
```

`workflowEnabled` becomes `false`: the routes 404 and `status` is a plain writable enum again, while
`workflow.json` and the stored states are kept. `weave workflow:open order` re-enables the same
definition.

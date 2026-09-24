---
description: "Turn a free status column on an object you already have into an ordered, role-gated, auditable lifecycle with approvals and timeouts."
---

# Putting a governed lifecycle on an existing object

The CRM from [Integrating an existing CRM with MCP](existing-crm-to-mcp.md) already exposes `orders`
to agents. Its `status` is a plain `enum` column: anyone with `update` can set it to any value, in any
order, with nothing recording *why* the value changed. This practice turns that column into a governed
lifecycle — declared transitions, per-transition roles, a human approval step and a timeout — without
changing the table shape or moving the data.

## Background

An `enum` column is a set of allowed values, not a lifecycle. It has no notion of a legal move
(`paid` → `pending` is as valid as `pending` → `paid`), no per-transition role gate, and no record of
"who advanced this, when, and from where". Whatever ordering the business has in mind lives only in the
application, so any writer — a person, a script, or an agent through `update_record` — can bypass it.

A **workflow** is a declarative state machine for one object, declared next to the object's schema. It
is **opt-in**: add the switch to `objects/<name>/schema.json` and put the machine in a sibling
`objects/<name>/workflow.json`. The engine then makes the state field read-only except through a
declared transition.

## Benefits

- **Constrained moves** — an action that does not exist, or does not fire from the current state, is
  rejected (`workflow.transition.unknown` / `workflow.transition.notAllowed`) instead of silently
  writing.
- **The state field is engine-managed** — a direct `PATCH` / `update_record` can never bypass the
  machine (`400 workflow.transition.required`).
- **Role gates and approvals** — `roles` on a transition narrows who may fire it; `requiresApproval`
  holds a move for the human-in-the-loop queue, and fails closed if no queue is configured.
- **Durable timeouts** — a state can carry an `onTimeout`; the engine arms a persisted timer and fires
  the declared action as a system transition when it expires.
- **Attributable history** — every move is a `transition` audit event and a `record.transitioned` live
  event, carrying the definition's `version` and semantic hash.
- **No code required** — the definition works without the script subsystem; optional hooks let you
  react in `server.js` when you want to.

## When to use this

Reach for a workflow when a single object has a **multi-step governed lifecycle** — ordered states,
per-transition permissions, approvals, or time-based escalation:

- you want illegal moves rejected, not just discouraged by convention;
- different transitions are allowed for different roles;
- a move needs a human approval, or a stale record should expire on its own.

A fixed set of values with no ordering rules does not need a workflow — a plain `enum` field is the
right tool. And a machine that coordinates **several objects** (sagas, parallel branches, scheduled
fan-out, in-flight definition pinning at scale) is beyond the engine's single-entity state machine;
the reference page and the enterprise seam note where that line is.

## Scenario

Building on [existing-crm-to-mcp](existing-crm-to-mcp.md): the `orders` object, roles `sales` (own
rows) and `manager` (all rows), acting as `alice` (a sales rep). The order lifecycle:

```
pending ──pay──▶ paid ──fulfill──▶ fulfilled
   │                                  │
   └──cancel──▶ cancelled ◀──refund───┘
```

| State | Meaning | Timeout |
| --- | --- | --- |
| `pending` (initial) | created, awaiting payment | 7 days → `cancel` |
| `paid` | customer paid | — |
| `fulfilled` | delivered | — |
| `cancelled` | terminal | — |

| Action | From → To | Who | Gate |
| --- | --- | --- | --- |
| `pay` | pending → paid | sales | role |
| `fulfill` | paid → fulfilled | manager | role |
| `cancel` | pending → cancelled | sales | role (also the timeout action, fired as system) |
| `refund` | fulfilled → cancelled | any updater | `requiresApproval` |

## 1. Start from the object you already have

Follow [Integrating an existing CRM with MCP](existing-crm-to-mcp.md) so `objects/orders/schema.json`
describes the live `orders` table. (Greenfield? `weave object:create orders` gives you the same
starting point.) Nothing below changes the table — it only adds a sibling definition.

## 2. Add the extra state to the enum and tighten writes

The lifecycle needs a `fulfilled` state the enum does not have yet, and the state field must stop being
directly writable. Edit `objects/orders/schema.json`:

```jsonc
{
  "name": "orders",
  "workflowEnabled": true,                       // set by `workflow:open` below; shown here for clarity
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "customer_id", "type": "relation", "target": "customers", "required": true },
    { "name": "amount", "type": "currency" },
    { "name": "status", "type": "enum", "options": ["pending", "paid", "fulfilled", "cancelled"] },
    { "name": "owner_id", "type": "string", "ownership": true },
    { "name": "created_at", "type": "datetime" }
  ],
  "permissions": {
    "sales":   { "read": "own", "create": true, "update": ["amount"], "delete": false },
    "manager": { "read": "all", "create": true, "update": true, "delete": true }
  }
}
```

`status` is no longer in `sales`'s update allowlist — the machine owns it now. `manager` keeps
`update: true`, but the engine still rejects a direct write to the state field.

> An `enum` is stored as a validated `VARCHAR` (the options are checked in the data-access layer, not by
> the column type), so **adding an option needs no DDL**. On the live table, any existing `status`
> values remain valid.

## 3. Turn the workflow on

```sh
weave workflow:open orders --state-field status --states pending,paid,fulfilled,cancelled
```

This does three things and auto-commits them:

- sets `"workflowEnabled": true` in `schema.json`;
- **reuses** the existing `status` enum (`--state-field`) instead of adding a new column — every
  `--states` name must already be an enum option;
- writes `objects/orders/workflow.json` with a starter machine (`initial` = the first state, a generic
  `advance` chain plus `reopen`).

Omit `--states` to use the whole option list; omit `--state-field` and the command creates a `status`
enum for you. `weave workflow:close orders` later flips `workflowEnabled` back to `false` and keeps the
file.

## 4. Migrate

```sh
weave migrate
```

Because the definition reuses the existing `status` column, this generates **zero DDL** — it just
validates the declared fields against the live table and registers the metadata cache. (If
`workflow:open` had added a *new* state column instead, this is also where it is created, and you would
backfill existing rows to the initial state — the CLI prints the exact `UPDATE`.)

## 5. Declare the case's transitions

Replace the starter `transitions` in `objects/orders/workflow.json` with the lifecycle from the
scenario, and add the timeout and an author `version`:

```jsonc
{
  "schemaVersion": 1,
  "version": 1,
  "stateField": "status",
  "initial": "pending",
  "states": [
    { "name": "pending", "labels": { "en": "Awaiting payment" },
      "onTimeout": { "after": "7d", "action": "cancel" } },
    { "name": "paid",      "labels": { "en": "Paid" } },
    { "name": "fulfilled", "labels": { "en": "Fulfilled" } },
    { "name": "cancelled", "labels": { "en": "Cancelled" } }
  ],
  "transitions": [
    { "action": "pay",     "from": "pending",   "to": "paid",      "roles": ["sales"], "labels": { "en": "Record payment" } },
    { "action": "fulfill", "from": "paid",      "to": "fulfilled", "roles": ["manager"], "labels": { "en": "Fulfil" } },
    { "action": "cancel",  "from": "pending",   "to": "cancelled", "roles": ["sales"], "labels": { "en": "Cancel" } },
    { "action": "refund",  "from": "fulfilled", "to": "cancelled", "requiresApproval": true, "labels": { "en": "Refund" } }
  ]
}
```

- `roles` is an **additional** gate on top of the object's `update` permission; omit it and any
  updater may fire the transition.
- `requiresApproval: true` suspends the move until it is approved.
- The `onTimeout` action runs as a **system** transition, so its `roles` are not applied to the timer.

## 6. Run it and drive one order

```sh
weave dev
```

Inspect a record — `actions` lists only the transitions fireable from its current state by your roles:

```sh
curl -H "Authorization: Bearer sk-admin" \
  http://localhost:3000/api/objects/orders/O-1001/workflow
# { "state": "pending", "initial": "pending",
#   "actions": [{ "action": "pay", "to": "paid", "labels": { "en": "Record payment" } },
#               { "action": "cancel", "to": "cancelled", "labels": { "en": "Cancel" } }] }
```

Fire one — the response is the updated record:

```sh
curl -X POST -H "Authorization: Bearer sk-admin" \
  http://localhost:3000/api/objects/orders/O-1001/transitions/pay
```

Now exercise the gates:

- `transitions/fulfill` as `alice` (sales) → `403 workflow.transition.denied`;
- `transitions/refund` → `409 workflow.transition.pending` with an `approvalKey`; approve it through the
  [approval queue](../guides/approvals.md), then retry the same call;
- `PATCH /api/objects/orders/O-1001` with `{ "status": "fulfilled" }` →
  `400 workflow.transition.required`.

## 7. From an agent (MCP)

The agent uses the same rules. A `workflow_transition` tool appears for objects that declare a workflow
**and** that the identity may update:

```jsonc
{ "name": "workflow_transition",
  "arguments": { "object": "orders", "id": "O-1001", "action": "fulfill" } }
```

`describe_object` surfaces the object's workflow so the agent can pick a valid action for the current
state, and RBAC still trims the tool per identity. See
[Connect an agent](connect-agent.md) for the two headers a session needs.

## 8. From the client SDK

```ts
import { createClient } from '@weave-kit/client';

const client = createClient({ baseUrl: 'http://localhost:3000', apiKey: 'sk-admin' });

const { state, actions } = await client.workflow.get('orders', 'O-1001');
await client.workflow.transition('orders', 'O-1001', 'pay');

client.subscribe({ object: 'orders' }, (event) => {
  if (event.type === 'record.transitioned') {
    const { from, to, action, workflowVersion, workflowHash } = event.payload;
    console.log(`${action}: ${from} → ${to} @ v${workflowVersion} (${workflowHash})`);
  }
});
```

## 9. Let `pending` expire on its own

The timeout from step 5 needs the scheduler switched on — enable the workflow subsystem in
`weavekit.config.ts` (or `weave module:add workflow`):

```ts
export default { subsystems: { workflow: { enabled: true } } };
```

The engine keeps one durable timer per record in `weavekit_workflow_timers` (PostgreSQL, claimed with
`FOR UPDATE SKIP LOCKED`, so multiple instances never double-fire). When a timer is due it dispatches
the `onTimeout` script hook (if `server.js` defines one) and then fires the declared action — here
`cancel` on an order still in `pending` after seven days. Entering a state with `onTimeout` arms the
timer; leaving it, or deleting the record, cancels it. `pollMs` and `batchSize` are configurable, and
the timer store is a pluggable backend.

## 10. Evolve the machine safely

The team later renames `fulfilled` to `shipped`. Bump the author `version`, declare the new state, and
add a `migrations` remap so records in the old state are not stranded:

```jsonc
{
  "version": 2,
  "stateField": "status",
  "initial": "pending",
  "states": [{ "name": "pending" }, { "name": "paid" }, { "name": "shipped" }, { "name": "cancelled" }],
  "transitions": [
    { "action": "pay",  "from": "pending", "to": "paid",    "roles": ["sales"] },
    { "action": "ship", "from": "paid",    "to": "shipped", "roles": ["manager"] }
  ],
  "migrations": [{ "from": "fulfilled", "to": "shipped" }]
}
```

```sh
weave workflow:migrate orders --dry-run   # report what would move; nothing changes
weave workflow:migrate orders             # UPDATE "orders" SET "status"='shipped' WHERE "status"='fulfilled'
```

`weave workflow:migrate` writes a system-actor `workflow.migrated` audit event and warns about any
record left in a state that is neither declared nor remapped. The old enum option is kept in place, so
no destructive DDL is needed. Author `version` and the definition's semantic hash are surfaced in the
descriptor, in every transition event/audit and on each timer.

`workflow.json`'s on-disk format has its own version, handled separately by `weave workflow:upgrade`.

## 11. Turn it off

```sh
weave workflow:close orders
```

`workflowEnabled` becomes `false`: the workflow routes 404 and `status` is a plain writable enum again,
while `workflow.json` and the stored states are kept. `weave workflow:open orders` re-enables the same
definition unchanged. See the [Workflow guide](../guides/workflow.md) for the full reference.

## Verify

Against your own PostgreSQL, confirm:

- **Direct write rejected** — `PATCH` `status` → `400 workflow.transition.required`.
- **Role gate** — `alice` firing `fulfill` → `403 workflow.transition.denied`.
- **Unknown / illegal move** — an action that does not exist → `404 workflow.transition.unknown`; one
  that exists but not from this state → `409 workflow.transition.notAllowed`.
- **Approval** — `refund` → `409 workflow.transition.pending` with an `approvalKey`; after approval the
  retried call succeeds.
- **Timeout** — an order left in `pending` past the window is moved to `cancelled` by the scheduler; a
  record that left `pending` first is not touched.
- **Audit** — `weavekit_audit` shows a `transition` row per move and a `workflow.migrated` row for the
  remap, each naming the acting subject or `system`.
- **Events** — subscribers receive `record.transitioned` with `from`, `to`, `action`, `workflowVersion`
  and `workflowHash`.

## Known constraints

- **One live definition** — the engine runs a single revision and does not pin per record. `version` and
  the semantic hash make history attributable; concurrent revisions in flight are enterprise-scope.
- **State field shape** — `stateField` must be a single-valued `enum`, and its options must list every
  declared state. `weave workflow:open --state-field` will not add options for you — add them first.
- **Transitions still need `update`** — a transition runs through the same RBAC as `update`, scoped to
  the rows the identity may write; `roles` is a tighter gate on top.
- **Removing a state needs a remap** — otherwise records are stranded; use `migrations` +
  `weave workflow:migrate`. The old enum option is intentionally never dropped.
- **Single-entity** — coordination across several objects, or high-availability timer/policy concerns,
  sits beyond the engine baseline.

## Security

- The state can only change through a declared transition, so an agent or script cannot invent a state.
- A transition that requires approval **fails closed** (`workflow.approval.unavailable`) when no
  approval queue is configured — it never fires unattended.
- The `workflow` route returns only the actions the caller's roles may currently fire, so an agent sees
  exactly the moves it is allowed to make.
- Guardrail policies from the [open contract](../guides/custom-tools-and-guardrails.md) also apply,
  keyed by `ctx.action = workflow.transition.<object>.<action>`.

## Next

- [Workflow](../guides/workflow.md) — the full reference: schema shape, hooks, REST contract, versions
  and evolution.
- [Designing an agent-friendly schema](agent-friendly-schema.md) — describe the state field so the
  agent reasons about it correctly.
- [Approvals](../guides/approvals.md) — the human-in-the-loop queue behind `requiresApproval`.
- [Script subsystem](../guides/script-hooks.md) — `beforeTransition` / `afterTransition` / `onEnter` /
  `onExit` / `onTimeout` hooks.

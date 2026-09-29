# Govern a lifecycle end to end

This walks a single-line **approval chain** onto an existing object, using the engine-owned
three-layer workflow (instance / step / workitem). Nothing is written to the customer table.

## 0. Prerequisites

- A project with the engine installed and `DATABASE_URL` set.
- The identity directory populated: node roles are resolved against `weavekit_user.roles`, so users
  (and their roles) must exist. Seed them with `weave sync:identity` (see the identity guide), or
  insert rows directly for a quick trial.

## 1. Enable a starter chain

```bash
weave object:create order
weave workflow:open order --roles approver
```

This writes `objects/order/workflow.json` with a single `review` node (role `approver`, 或签) and
flips `workflowEnabled` in `schema.json`. Edit the chain — for example a 会签 finance step and a final
manager step:

```json
{
  "schemaVersion": 2,
  "version": 1,
  "nodes": [
    { "id": "finance", "name": { "en": "Finance" },
      "assign": { "roles": ["finance"], "mode": "all" },
      "onTimeout": { "after": "3d", "action": "reject" } },
    { "id": "manager", "name": { "en": "Manager" },
      "assign": { "roles": ["manager"], "mode": "any" }, "onReject": "finance" }
  ]
}
```

## 2. Migrate

```bash
weave migrate
```

`migrate` provisions the engine tables and content-addresses the definition. It never alters the
`order` table.

## 3. Run a record

Create a record and start the chain (as the **originator**):

```bash
POST /api/objects/order/<id>/workflow/submit
```

The instance is now `running` at `finance`; every finance user has an open workitem. Inspect:

```bash
GET /api/objects/order/<id>/workflow
# → { state: "running", node: "finance", actions: [...], workitems: [...] }
```

- **会签** (`mode: "all"`) finishes `finance` only after every finance user approves.
- A **reject** rolls back to `onReject` (here `finance`; default would be the start node, where the
  originator edits in place and resubmits). A **withdraw** does the same but is initiated by the
  participant.
- **forward** re-assigns an open workitem: `POST …/workflow/forward` with `{ "to": { "userId": "…" } }`.

When the last node is approved the instance is `finished` and the record's mirrored status is
`effective`.

## 4. The caller's inbox

```bash
GET /api/workflow/todos
# → { items: [ { object, recordKey, workitemId, nodeId, ... } ] }
```

## 5. Presence lock (UI)

While a participant has the record open, the UI holds a 60s lease so a concurrent withdraw/cancel is
blocked:

```bash
POST   /api/objects/order/<id>/workflow/lock     # acquire / renew (heartbeat)
DELETE /api/objects/order/<id>/workflow/lock     # on close
```

## 6. Timeouts

`finance` above auto-rejects after 3 days. Enable the scheduler once:

```ts
// weavekit.config.ts
export default { subsystems: { workflow: { enabled: true } } };
```

## 7. Admin re-activation

An admin (`admin` role) can re-open a terminal instance at any node — same pinned revision:

```bash
POST /api/objects/order/<id>/workflow/reactivate   { "node": "manager" }
```

## 8. History & audit

`GET /api/objects/order/<id>/workflow/history` returns the instance plus every step and workitem
(who acted, when, approval, comment, forwards). The audit trail records a `transition` event and the
live channel emits `record.transitioned`.

## 9. Evolve safely

Edit `workflow.json` (add nodes, change roles/modes) and run `weave migrate`. **New** records use the
new version; records already running keep executing the revision they started under. To roll new
records back onto a prior revision:

```bash
weave workflow:switch order --revision 1
```

Remember: **the object's own table is never touched** — you can attach, evolve or remove a workflow
without a migration on the customer schema.

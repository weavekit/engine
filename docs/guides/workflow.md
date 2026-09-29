# Workflow

A **workflow** is a single-line approval chain for one object. It is **opt-in** and, crucially,
**non-invasive**: instance state, the current node and every participant's task live in engine-owned
tables — the customer's table is **never altered and never written**, so a workflow can be layered on
an existing database. Each record runs through one instance (which can be re-activated), one node at
a time.

## Enabling

Turn the switch on in `objects/<name>/schema.json` and put the chain in a sibling
`objects/<name>/workflow.json`:

```json
{
  "name": "order",
  "workflowEnabled": true,
  "fields": [{ "name": "id", "type": "string", "primary": true }]
}
```

The fastest way is the CLI: `weave workflow:open <object>` scaffolds a starter chain (`--roles a,b`
sets the node roles); `weave workflow:close <object>` turns it off (the file is kept). For a
step-by-step case see [Governing a lifecycle](../practices/workflow-end-to-end.md).

`workflowEnabled` is the source of truth: absent or `false` means disabled — the definition file is
ignored and the workflow routes `404`, while the file is kept. `true` without a `workflow.json` fails
validation (`workflow.definition.missing`).

## Definition (`workflow.json`, format v2)

```json
{
  "schemaVersion": 2,
  "version": 1,
  "nodes": [
    { "id": "cc", "kind": "notify", "assign": { "roles": ["finance"] } },
    { "id": "finance", "name": { "en": "Finance review" },
      "assign": { "roles": ["finance"], "mode": "any" },
      "onReject": null, "onWithdraw": null,
      "onTimeout": { "after": "3d", "action": "reject" } },
    { "id": "manager", "assign": { "roles": ["manager"], "mode": "all" }, "onReject": "finance" }
  ]
}
```

- **`nodes`** is an ordered chain. The **start node is implicit** (`__start__`, the originator) — it is
  never authored and does not appear in `nodes`.
- **`kind`** — `approve` (default) or `notify` (抄送: no approval, advances immediately).
- **`assign.roles`** (required) are resolved to internal users through `weavekit_user.roles` (see B).
  A node that resolves to **no users fails closed** (`workflow.assignee.none`).
- **`assign.mode`** — `any` (或签, default: the first decision settles the node) or `all` (会签: every
  assignee must approve). `notify` nodes never use `all`.
- **`onReject` / `onWithdraw`** name an **earlier** node id to roll back to; absent = the start node.
- **`onTimeout`** — `{ after: "<duration>", action: "approve" | "reject" }` (approve nodes only).

There is **no state field on the object** and no direct write path: a record's workflow position is
engine-owned, so it can never be bypassed by `PATCH` / `update_record`.

## The three layers

| Layer | Table | One row per | Notes |
| --- | --- | --- | --- |
| Instance | `weavekit_workflow_instances` | record (`object`, `record_key`) | `running` / `finished` / `canceled`; pins `workflow_hash` |
| Step | `weavekit_workflow_steps` | node entry (incl. re-visits) | `active` / `finished` / `skipped` / `canceled` |
| Workitem | `weavekit_workflow_workitems` | assignee (user) | `waiting` / `active` / `done` / `canceled` / `transferred`; carries `approval`, `comment`, `finisher`, `delegant`, `receiptor` |

The object's side table (`weavekit_record__<object>.status`) is a **read-only mirror** of the instance
lifecycle: no instance → `draft`, `running` → `running`, `finished` → `effective`, `canceled` →
`canceled`. After `submit` the record **never returns to `draft`** — a rollback only moves the chain
back to a node (or the start node), where the originator edits in place.

## Actions

| Action | By | Effect |
| --- | --- | --- |
| `submit` | originator | starts the instance (or resubmits from the start node); enters `nodes[0]` |
| `approve` | a workitem assignee | advances (或签: first approval; 会签: all approvals) |
| `reject` | a workitem assignee | rolls back to `onReject` (default: the start node) |
| `withdraw` | a workitem assignee or the originator | rolls back to `onWithdraw` (default: the start node) |
| `cancel` | the originator | terminates the instance (`canceled`) |
| `forward` | a workitem assignee | hands the item to another user (`{ to: { userId } }`); the source is marked `transferred` |
| `reactivate` | an admin (`admin` role) | re-opens a terminal instance at a chosen node (same pinned revision) |

## Timeouts (`onTimeout`)

Enable the scheduler:

```ts
export default { subsystems: { workflow: { enabled: true } } };
```

Entering a node with `onTimeout` arms a durable timer in `weavekit_workflow_timers` (PostgreSQL,
claimed with `FOR UPDATE SKIP LOCKED`, so multiple instances never double-fire); leaving the node
cancels it. When due, the engine dispatches the `onTimeout` script hook (if any) and fires the
declared auto-action as the `system` actor. Options: `pollMs` (30000), `batchSize` (50), `backend` (a
pluggable `WorkflowBackend`; enterprise/HA seam).

## Hooks

With the [script subsystem](script-hooks.md) enabled, `objects/<name>/server.js` can react to
transitions:

| Hook | When | `this` |
| --- | --- | --- |
| `onExit` | after commit, leaving a node | `this.transition` (`{ from, to }` node ids), `this.state` (node left) |
| `onEnter` | after commit, entering a node | `this.transition`, `this.state` (node entered) |
| `afterTransition` | after commit | `this.transition`, `this.state` |
| `onTimeout` | when a node timer fires | `this.state` (node) |

Throws are non-fatal warnings (the transition is already committed). `beforeTransition` is **not**
dispatched: the workflow no longer writes a customer state field, so there is no pre-commit record
change to intercept.

## Versions & evolution

`workflow.json` carries an on-disk `schemaVersion` (migrated by `weave workflow:upgrade`) and an
optional author `version`; the engine derives a **semantic hash** over `{ version, nodes }`. Every
`weave migrate` content-addresses the current definition into `weavekit_workflow_definitions`
(append-only), and each instance **pins** the hash it started under — so a running record keeps
executing its original chain even after the file changes. New records use the file's current version.

- **`weave workflow:switch <object> --revision <seq>`** writes a registered revision back to
  `workflow.json` (affecting new records only). (`--revision` — `--version` is reserved by the CLI.)
- **Adding** nodes is safe. **Removing/renaming** only affects new records; running records keep their
  pinned revision and are unaffected.

## REST

```
GET    {prefix}/objects/:name/:id/workflow              → { state, node?, approval?, actions[], workitems[] }
POST   {prefix}/objects/:name/:id/workflow/:action      → run an action (body { comment } / { to:{userId} })
POST   {prefix}/objects/:name/:id/workflow/lock         → acquire/renew the presence lock
DELETE {prefix}/objects/:name/:id/workflow/lock         → release the presence lock
GET    {prefix}/objects/:name/:id/workflow/history      → instance + steps + workitems
GET    {prefix}/workflow/todos                          → the caller's pending workitems
```

`actions` lists only what the caller may do now. Errors: `404 workflow.transition.unknown`,
`409 workflow.transition.notAllowed`, `403 workflow.transition.denied`, `409 workflow.withdraw.locked`.

The **presence lock** (TTL 60s, renewed by the UI heartbeat) blocks `withdraw`/`cancel` while another
participant has the record open — closing the page (or the lease expiring) releases it.

## Permissions

An action runs through the same RBAC as `update` (an `update` permission + the caller's row scope), on
top of the **workitem gate**: an `approve`/`reject`/`forward` needs the caller to be the assignee of an
open workitem (admins may `reactivate`). Audit records a `transition` event (`action`, `from`, `to`,
`workflowHash`) and the live channel publishes `record.transitioned`.

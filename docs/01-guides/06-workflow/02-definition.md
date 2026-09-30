---
title: Definition
description: "The workflow.json format (v2): node kinds, assign modes, rollback, timeouts and validation."
---

# Definition

A workflow is one JSON file at `objects/<name>/workflow.json`, read alongside `schema.json`. The
object opts in with `"workflowEnabled": true`; the file itself is the chain.

```json
{
  "schemaVersion": 2,
  "version": 1,
  "nodes": [
    { "id": "cc", "kind": "notify", "assign": { "roles": ["finance"] } },
    { "id": "finance", "name": { "en": "Finance review" },
      "assign": { "roles": ["finance"], "mode": "any" },
      "onTimeout": { "after": "3d", "action": "reject" } },
    { "id": "manager", "assign": { "roles": ["manager"], "mode": "all" }, "onReject": "finance" }
  ]
}
```

## Top level

| Field | Required | Notes |
| --- | --- | --- |
| `nodes` | yes | Ordered chain, at least one node. The start node is implicit. |
| `schemaVersion` | no | On-disk format version. Optional for a `nodes[]` file — the engine infers v2. |
| `version` | no | Author-managed revision (a positive integer). Shows up in the descriptor/audit so history stays readable. |

`workflowEnabled` is the switch, and it lives in `schema.json`, not here. Absent or `false` means the
definition file is ignored (the workflow routes `404`) — but the file is kept. `true` with no
`workflow.json` fails validation (`workflow.definition.missing`).

## A node

```json
{
  "id": "finance",
  "kind": "approve",
  "name": { "en": "Finance review", "fr": "Validation finance" },
  "description": "Budget sign-off",
  "assign": { "roles": ["finance"], "mode": "all" },
  "onReject": "draft_review",
  "onWithdraw": null,
  "requiresApproval": false,
  "onTimeout": { "after": "3d", "action": "reject" }
}
```

| Field | Notes |
| --- | --- |
| `id` | snake_case, unique in the chain. |
| `kind` | `approve` (default) or `notify`. A `notify` node is cc-only — no quorum, it advances immediately once entered. |
| `name` | Display names keyed by locale, e.g. `{ "en": "Finance" }`. |
| `description` | Free text. |
| `assign.roles` | **Required, non-empty.** Roles that resolve to the node's assignees. |
| `assign.mode` | `any` (default) or `all`. `notify` nodes never use `all`. |
| `onReject` | On reject, roll back to this **earlier** node id. Absent = the start node. |
| `onWithdraw` | Same, for withdraw. |
| `requiresApproval` | When `true`, the action at this node must clear the approval queue before it fires. See [Admin & guardrails](06-admin.md). |
| `onTimeout` | `{ after, action }` — approve nodes only. See below. |

### kind

- **`approve`** — the node gates; assignees decide.
- **`notify`** — no decision, just visibility. Used for cc steps that shouldn't block the chain.

### assign.mode

- **`any`** (any-one) — the first decision settles the node. Everyone gets a workitem; the first to
  act closes the node and cancels the rest.
- **`all`** (all-must-approve) — every assignee must approve. One reject rolls the node back.

### Rollback targets

`onReject` and `onWithdraw` must point at a node **earlier** in the chain (or be omitted, meaning the
start node). A target that isn't earlier is rejected at build time (`workflow.rollback.notEarlier`).
There's no forward jump: rollback is always backward.

### Timeouts

```json
"onTimeout": { "after": "72h", "action": "reject" }
```

- `after` — a duration: a number with an optional unit `ms | s | m | h | d | w` (a bare number is
  milliseconds).
- `action` — `approve` or `reject`, fired as the `system` actor when the timer expires. Omit it to
  only dispatch the `onTimeout` script hook.

`onTimeout` is for `approve` nodes; a `notify` node rejects it (`workflow.timeout.invalid`). Entering
the node arms a durable timer; leaving it cancels the timer. See [Lifecycle](03-lifecycle.md).

## Validation

- `workflow.notObject` — the file isn't a JSON object.
- `workflow.nodes.required` — missing or empty `nodes`.
- `workflow.node.invalid` — bad `id` (not snake_case or duplicated), `kind`, `assign`, `assign.roles`
  or `assign.mode`.
- `workflow.rollback.notEarlier` — a rollback target that isn't an earlier node.
- `workflow.timeout.invalid` — a bad `after`/`action`, or `onTimeout` on a `notify` node.
- `workflow.version.invalid` — `version` isn't a positive integer.
- `workflow.definition.missing` — `workflowEnabled: true` with no definition file.
- `workflow.assignee.none` — runtime: a node's roles resolve to no users.

## Older formats

Format **v1** was a state machine (`stateField` + `states[]` + `transitions[]`). It's linearized into
a node chain on read, so old files keep loading. To rewrite them on disk:

```bash
weave workflow:upgrade          # stamps/linearizes every objects/*/workflow.json
```

A file that declares a **newer** version than the engine supports aborts
(`schema.version.unsupported`).

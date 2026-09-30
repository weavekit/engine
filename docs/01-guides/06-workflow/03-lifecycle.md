---
title: Lifecycle
description: "Instance states, the seven actions, quorum, side-mirror status, presence locks and transition hooks."
---

# Lifecycle

## States

An instance is `running`, `finished` or `canceled`. The record's mirrored status (in the engine's
`weavekit_record__<object>.status` side table) tracks it:

| Instance | Mirrored status |
| --- | --- |
| no instance yet | `draft` |
| `running` | `running` |
| `finished` | `effective` |
| `canceled` | `canceled` |

After the first `submit` a record **never goes back to `draft`**. A rollback moves the chain back to
an earlier node (or the start node) where the originator edits in place and resubmits.

## Actions

| Action | Who | Effect |
| --- | --- | --- |
| `submit` | originator | Starts the instance (or resubmits from the start node); enters `nodes[0]`. |
| `approve` | a workitem assignee | Advances the node — any-one settles immediately, all needs everyone. |
| `reject` | a workitem assignee | Rolls back to `onReject` (default: the start node). |
| `withdraw` | a workitem assignee or the originator | Rolls back to `onWithdraw` (default: the start node). |
| `cancel` | originator | Terminates the instance (`canceled`). |
| `forward` | a workitem assignee | Hands the item to another user (`{ "to": { "userId": "…" } }`); the source workitem is marked `transferred`. |
| `reactivate` | an admin | Re-opens a terminal instance at a chosen node, on the same pinned revision. |

`reject`, `withdraw` and `cancel` share one rollback/terminate primitive — they differ in who may fire
them and which target they use.

### Quorum

At an `any` node the first decision settles it: the node closes and the other open workitems are
canceled. At an `all` node every assignee must approve; a single reject rolls back. `notify` nodes have
no quorum — they advance as soon as they're entered.

### Forward

`forward` doesn't change the node. It marks the caller's workitem `transferred` and opens a new
workitem for the receiptor (deduped if they already hold one).

## What a transition does

Every action runs in **one transaction** (`query.ts#transition`), taking the instance row `FOR UPDATE`
so concurrent decisions can't race:

1. Resolve the action and check authority (RBAC `update` + the workitem gate).
2. Move step/workitem rows and compute the next node.
3. Mirror the lifecycle into the side table.
4. Re-arm or cancel the node timer.
5. Audit a `transition` event (`action`, `from`, `to`, `workflowHash`).
6. After commit: publish `record.transitioned`, then dispatch the script hooks.

## Script hooks

With the [script subsystem](../07-automation/02-script-hooks/01-overview.md) on, `objects/<name>/server.js` can
react to transitions. All hooks run **after commit**.

| Hook | When | `this` |
| --- | --- | --- |
| `onExit` | leaving a node | `this.transition` (`{ from, to }`), `this.state` (node left) |
| `onEnter` | entering a node | `this.transition`, `this.state` (node entered) |
| `afterTransition` | after any move | `this.transition`, `this.state` |
| `onTimeout` | a node timer fires | `this.state` (node) |

A throwing hook is a non-fatal warning — the transition is already committed. `beforeTransition` is
**not** dispatched: the workflow writes no customer column, so there's nothing pre-commit to intercept.

## Presence lock

While a participant has the record open, the UI holds a **60s lease** (`POST
…/workflow/lock`, renewed by heartbeat). It blocks `withdraw`/`cancel` from another session — a
concurrent attempt fails with `workflow.withdraw.locked`. Closing the page (or letting the lease
expire) releases it. See the endpoints in [Adapters](05-adapters.md).

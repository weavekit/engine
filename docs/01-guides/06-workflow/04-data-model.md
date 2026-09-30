---
title: Data model
description: "The six engine tables behind a workflow, the side-mirror status table, and how definitions are pinned by hash."
---

# Data model

A workflow adds no columns to your table. Everything lives in engine-owned `weavekit_workflow_*`
tables, created by `weave migrate` and served by the runtime. Your customer table is only read.

| Table | One row per | Key columns |
| --- | --- | --- |
| `weavekit_workflow_instances` | record (`object`, `record_key`) | `state` (`running`/`finished`/`canceled`), `workflow_hash`, `node_id` |
| `weavekit_workflow_steps` | node entry (re-visits append a row) | `node_id` (includes `__start__`), `state` (`active`/`finished`/`skipped`/`canceled`) |
| `weavekit_workflow_workitems` | assignee (user) | `state` (`waiting`/`active`/`done`/`canceled`/`transferred`), `approval`, `comment`, `finisher`, `delegant`, `receiptor` |
| `weavekit_workflow_locks` | held workitem | 60s presence lease |
| `weavekit_workflow_definitions` | `(object, hash)` | append-only, content-addressed revisions |
| `weavekit_workflow_timers` | record (`object`, `record_key`) | `node_id`, `due_at`, `workflow_hash` |

Plus one **side table**: `weavekit_record__<object>.status` mirrors the instance lifecycle
(`draft`/`running`/`effective`/`canceled`). It's a read-only mirror — the workflow writes it, nothing
else should.

## Definitions are pinned by hash

`weave migrate` content-addresses the current `workflow.json` into
`weavekit_workflow_definitions` (append-only) and computes a **semantic hash** over `{ version, nodes }`.
When an instance starts it pins that hash. So:

- Editing `workflow.json` changes **new** records only.
- A record already running keeps executing the chain it started under, even if you renamed or removed
  nodes.

`workflowHash` also rides along on the `transition` audit events, so a historical trail stays
interpretable after the definition changes.

## Timers

Entering a node with `onTimeout` writes a row to `weavekit_workflow_timers` (`object`, `record_key`,
`node_id`, `due_at`, `workflow_hash`); leaving the node deletes it. The scheduler claims due rows with
`SELECT … FOR UPDATE SKIP LOCKED`, so running several engine instances never double-fires the same
timer. The store is behind a pluggable `WorkflowTimerStore` / `WorkflowBackend` seam (the default is
the PG store; an HA/enterprise backend can replace it). See [Adapters](05-adapters.md) for the config.

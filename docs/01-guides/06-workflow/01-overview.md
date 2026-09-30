---
title: Workflow
description: "Per-object approval chains that live entirely in engine tables — the customer table is never touched."
---

# Workflow

A workflow is a **single-line approval chain** for one object. A record moves through the nodes one at
a time; each node has assignees (by role) who approve, reject or forward.

Two properties matter:

- **Opt-in.** Flip `workflowEnabled` on the object and drop in a `workflow.json`.
- **Non-invasive.** The instance state, the current node and every participant's task live in
  engine-owned tables. The customer's table is **never altered and never written**, so you can layer a
  workflow on an existing database.

There is no state column on your object and no direct write path — the record's position is
engine-owned, so it can't be skipped with a `PATCH`.

## Quick start

```bash
weave workflow:open order --roles approver   # scaffold workflow.json + enable the object
weave migrate                                 # register the definition
```

Then `POST /api/objects/order/<id>/workflow/submit`. Full walkthrough:
[Governing a lifecycle end to end](../../03-practices/02-governance/03-workflow-end-to-end.md).

## How it fits together

- [Definition](02-definition.md) — the `workflow.json` format and every field
- [Lifecycle](03-lifecycle.md) — states, the actions, quorum, and what each transition does
- [Data model](04-data-model.md) — the engine tables behind it
- [Adapters](05-adapters.md) — the REST, MCP and CLI surface
- [Admin & guardrails](06-admin.md) — override, reactivate, definition write-back, approval gate

## Ground rules

- **Assignees come from roles.** A node lists roles; they resolve to users through `weavekit_user.roles`
  (`?|` on the `roles` jsonb). A node that resolves to nobody fails closed (`workflow.assignee.none`).
- **Rollback only goes backward.** `onReject`/`onWithdraw` must name an **earlier** node, or default to
  the start node.
- **The start node is implicit** — `__start__`, the originator. It never appears in `nodes`.
- **The chain is pinned by content.** Each instance records the definition hash it started under, so
  editing `workflow.json` never changes a record that's already running (only new records).

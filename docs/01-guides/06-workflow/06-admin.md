---
title: Admin & guardrails
description: "Admin override, reactivate, definition write-back, and how guardrail policies and the approval queue gate transitions."
---

# Admin & guardrails

Most of the time the normal [actions](03-lifecycle.md) are all you need. The rest of this page is the
admin escape hatches and the policy gate in front of a transition.

## Admin role

Admin actions require the caller to hold the role `admin` (the constant `WORKFLOW_ADMIN_ROLE`).
Regular actions don't need it — they go through normal RBAC plus the workitem gate.

## Override a running instance

`PATCH {prefix}/objects/:name/:id/workflow` moves a record to a node, or ends it — even while it's
running:

```json
{ "node": "manager" }                  // jump to this node (re-opens its workitems)
{ "state": "canceled" }                // terminate
{ "state": "finished" }                // mark done
```

Use this to unstick a record whose assignees have left, or to force a state an action can't reach.

## Re-activate a finished/canceled instance

```json
POST {prefix}/objects/:name/:id/workflow/reactivate   { "node": "manager" }
```

Admin-only. Re-opens a **terminal** instance at a chosen node, on the **same pinned revision** (the
definition hash doesn't change). A node that isn't in that revision fails with
`workflow.node.unknown`.

## Read/write the definition

```bash
GET {prefix}/objects/:name/workflow/spec
PUT {prefix}/objects/:name/workflow/spec
```

Admin-only, and the routes need `adapters.rest.adminRoles` plus a `schemaDir` (they write the project
tree). `GET` returns the raw `workflow.json` source plus a content-hash `version`.

`PUT` validates the candidate against the registered object and writes it through the shared source
transaction (atomic replace + `git commit --only`). Body is either the raw file or a structured form:

```json
{ "source": "{ \"nodes\": [ … ] }" }
{ "nodes": [ … ], "version": 2 }
```

Pass `expectVersion` for optimistic locking — a stale value is rejected (`409`), so two editors can't
silently clobber each other. Changes affect **new** records; running instances keep their pinned
revision. (Same as editing the file and running `weave workflow:switch`.)

## The approval gate

A node can declare `"requiresApproval": true`. When it (or a guardrail policy) demands approval, the
action is routed through the **approval queue** — the same queue used for tool calls — before it fires:

- approval pending → `409 workflow.transition.pending`
- the node needs approval but no queue is configured → `409 workflow.approval.unavailable`

Guardrail policies run on every transition and self-filter on the action key
`workflow.transition.<object>.<action>`, so a policy only sees the transitions it names. For the queue
itself and how to resolve entries, see [Approvals](../05-agents/04-approvals.md) and
[Custom tools & guardrails](../05-agents/03-custom-tools-and-guardrails/01-overview.md).

---
title: Tool surface
description: "The fixed MCP registry: one generic tool per capability, filterable per identity."
---

# Tool surface

The surface is a **fixed registry** — it does not grow with the number of objects. Each capability the
identity holds on at least one object is exposed as one generic tool; the target object is an argument:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `search_records` | list an object's records (row scope applied) | `object`, `filter`, `sort`, `limit` (≤1000), `offset`, `fields` |
| `get_record` | fetch one record by record id (`weave_id`) | `object`, `id` |
| `create_record` | create (writable fields only) | `object`, `data` |
| `update_record` | update (RBAC `update` whitelist only) | `object`, `id`, `changes` |
| `delete_record` | delete (row scope applied) | `object`, `id` |
| `workflow_transition` | fire a declared [workflow](../../06-workflow/01-overview.md) transition (present when the identity can update an object with a workflow) | `object`, `id`, `action` |

Always present:

| Tool | Purpose |
| --- | --- |
| `list_objects` | objects the identity can read (`[{ name, labels }]`) |
| `describe_object` | schema (fields, relations, registered-type `attrs` with their spec) + the identity's effective permissions |

## Ids and discovery

`object` is the object name; `id` is the record's **external id** — its `record_key`, the
length-prefixed encoding of the (possibly composite) primary key, returned as the `weave_id` field.
Read it from a result (or `describe_object`) rather than composing it by hand; a `find` only returns
`weave_id` when you ask for it in `fields`.

The generic schemas deliberately do **not** enumerate per-object fields — that's what keeps the surface
small — so an agent should call `describe_object` first to learn an object's fields, relations and its
own permissions. For a workflow object, `describe_object` also returns its `workflow` (nodes +
actions), which `workflow_transition` then fires by `action`.

## RBAC shaping

Tool shaping follows RBAC exactly:

- an operation tool appears only when the identity may perform it on at least one object;
- an object with no listed role contributes nothing;
- `update: []` grants no update;
- `fields.exclude` fields are stripped from results and rejected on write.

RBAC is enforced **again per object at call time**, so a field or row outside the identity's scope is
rejected even when the tool itself is present.

## Related

- [MCP overview](01-overview.md) — sessions and wiring
- [Workflow](../../06-workflow/05-adapters.md) — the `workflow_transition` tool
- [RBAC](../../04-access/02-rbac.md)

---
title: Adapters
description: "The REST endpoints, the MCP tool, the CLI commands and the scheduler config for a workflow."
---

# Adapters

## REST

```
GET    {prefix}/objects/:name/:id/workflow           → { state, node?, approval?, actions[], workitems[] }
POST   {prefix}/objects/:name/:id/workflow/:action   → run an action (body { comment } / { to:{userId} })
PATCH  {prefix}/objects/:name/:id/workflow           → admin override (see Admin & guardrails)
POST   {prefix}/objects/:name/:id/workflow/lock      → acquire/renew the presence lock
DELETE {prefix}/objects/:name/:id/workflow/lock      → release the presence lock
GET    {prefix}/objects/:name/:id/workflow/history   → instance + steps + workitems
GET    {prefix}/workflow/todos                       → the caller's pending workitems
GET    {prefix}/objects/:name/workflow/spec          → raw workflow.json + version (admin)
PUT    {prefix}/objects/:name/workflow/spec          → validate + write + commit workflow.json (admin)
```

- `actions` in `GET …/workflow` lists only what the caller may do right now — render buttons from it.
- `POST …/workflow/:action` takes `{ "comment": "…" }` and, for `forward`, `{ "to": { "userId": "…" } }`.
- A legacy `POST {prefix}/objects/:name/:id/transitions/:action` alias is kept for older clients.

## MCP

Agents go through one tool, `workflow_transition`. It's present only when the identity may update an
object that has a workflow, and it forwards `{ object, id, action, comment?, to? }`:

```json
{ "object": "order", "id": "ord-1", "action": "approve", "comment": "ok" }
```

See [MCP](../05-agents/02-mcp/01-overview.md) for the wider tool surface.

## CLI

```bash
weave workflow:open <object> [--roles a,b]   # scaffold workflow.json + set workflowEnabled
weave workflow:close <object>                # set workflowEnabled: false (keeps the file)
weave workflow:switch <object> --revision N  # write a registered revision back to workflow.json
weave workflow:upgrade [--dry-run]           # migrate/stamp legacy workflow.json files
```

`weave migrate` registers (content-addresses) the current definition so instances can pin it.
`--revision` — `--version` is reserved by the CLI parser.

## Scheduler config

The onTimeout scheduler is off unless the subsystem is enabled:

```ts
export default {
  subsystems: {
    workflow: {
      enabled: true,
      pollMs: 30_000,   // default
      batchSize: 50,    // timers claimed per tick
      // backend: custom WorkflowBackend (default: the PG store)
    },
  },
};
```

## Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `workflow.transition.unknown` | 404 | The object has no workflow, or the action isn't recognized. |
| `workflow.transition.notAllowed` | 409 | The action doesn't apply in the current state. |
| `workflow.transition.required` | 409 | The record needs a workflow action before this write. |
| `workflow.transition.denied` | 403 | The caller isn't allowed (not the assignee / not the originator / not admin). |
| `workflow.transition.pending` | 409 | The node requires approval and it hasn't cleared the queue yet. |
| `workflow.withdraw.locked` | 409 | Someone holds the presence lock. |
| `workflow.assignee.none` | 409 | A node's roles resolved to no users. |
| `workflow.node.unknown` | 409 | A referenced node id isn't in the pinned revision. |
| `workflow.approval.unavailable` | 409 | A node needs approval but no approval queue is configured. |

Error codes are stable and localized — see [Localization](../09-platform/04-i18n.md).

---
title: Custom tools
description: "Register your own tools beside the generic CRUD surface, with a controlled ctx."
---

# Custom tools

Custom tools are TypeScript (or JS) modules that export a `ToolDefinition` as their default export.
Each module becomes one tool on the engine's **per-identity tool surface**, merged with the generic
registry CRUD tools and the introspection tools and filtered by the identity's roles.

Agents reach that surface through the MCP adapter. Your own host code can invoke the same tool
directly through `engine.tools.executor`, with the same policies and the same audit.

## Configure

```ts
// weavekit.config.ts
export default {
  // ...
  tools: {
    toolsDir: 'tools',              // custom tool directory, relative to schemaDir (default 'tools')
  },
};
```

Without `tools.toolsDir`, nothing is loaded — zero overhead.

## Write a tool

```ts
// tools/reassign_ticket.ts
import type { ToolDefinition } from '@weave-kit/engine';

export default {
  name: 'reassign_ticket',
  description: 'Transfer a ticket to another agent',
  inputSchema: {                              // plain JSON Schema (field types map 1:1)
    type: 'object',
    properties: { ticket_id: { type: 'string' }, to_agent: { type: 'string' } },
    required: ['ticket_id', 'to_agent'],
  },
  roles: ['agent', 'admin'],                  // allow-list: roles not listed never see this tool
  handler: async (ctx) => {
    const ticket = await ctx.dataAccess.update(
      'ticket',
      ctx.args.ticket_id as string,
      { assignee_id: ctx.args.to_agent },
      { subject: ctx.subject },               // RBAC is enforced on every call
    );
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: ticket.id }) }] };
  },
} satisfies ToolDefinition;
```

`roles` is an **allow-list only**. The engine has no role registry, so an unknown role is simply
invisible to identities that don't list it. Omitting `roles` makes the tool visible to everyone.

## The controlled `ctx`

A handler gets everything it may need and nothing it shouldn't — **no raw pool, SQL, or network
access**:

| Field | What it is |
| --- | --- |
| `dataAccess` | RBAC-decorated object access: `find / findOne / create / update / delete` (narrow `ToolDataAccess` surface) |
| `subject` | the proxied user (RBAC decisions run against this) |
| `actor` | the caller: `{ key, label, onBehalfOf }` (agent API key → audit `actorId`) |
| `args` | this invocation's arguments |
| `action` | the audit action, e.g. `mcp.tool.reassign_ticket` |
| `audit` | the audit sink (write custom events with `audit.record(...)`) |
| `guardrails` | rate-limit / alert handle (`guardrails.checkRateLimit(key)`) |
| `approvals` | the approval queue handle (`query / approve / reject`) |
| `withTx(fn)` | **cross-object atomic** execution — `fn` runs inside one transaction; a throw rolls everything back |

```ts
handler: async (ctx) => {
  return ctx.withTx(async (tx) => {
    await tx.dataAccess.create('ticket', { /* ... */ }, { subject: tx.subject });
    await tx.dataAccess.update('lead', ctx.args.lead_id as string, { status: 'won' }, { subject: tx.subject });
    return { content: [{ type: 'text', text: 'done' }] };
  });
},
```

> The id argument to `dataAccess` (`findOne` / `update` / `delete`) is the record's **`record_key`**
> (the `weave_id` field), not the raw primary-key value.

## Naming rules

Tool names must match `^[a-z][a-z0-9_]*$` and must **not** collide with the built-in surface: the
`search_records` / `get_record` / `create_record` / `update_record` / `delete_record` registry tools,
the `list_objects` / `describe_object` introspection tools, or the `mcp.` audit namespace. A violation
fails startup with a clear error.

## Loading & production build

The loader dynamic-imports `.js / .mjs / .cjs` (and `.ts` while `tsx` is registered, i.e. under
`weave dev`). For production:

- `weave build` compiles `tools/*.ts` → `dist/tools/*.js` automatically when the directory exists.
- Point `tools.toolsDir` at `dist/tools` in production config.

## Related

- [Guardrail policies](03-guardrails.md) — gate these tools
- [MCP tool surface](../02-mcp/02-tool-surface.md) — how tools appear to agents
- [Audit replay](04-audit-replay.md)

---
title: Prompts
description: "User-invoked, schema-derived prompt templates (built-in) plus a host provider for business prompts."
---

# Prompts

MCP has three primitives: **tools** (the model calls them), **resources** (the app attaches context),
and **prompts** — templates the **user** triggers from their client (a slash-command or a picker). A
prompt expands into ready-made messages that steer the conversation.

The engine ships a small set of **schema-derived** built-in prompts — it never authors business
content — and lets you inject your own through a provider.

## Built-in prompts

Derived from the schema and filtered by the identity's RBAC — no configuration:

| Prompt | Args | Returns |
| --- | --- | --- |
| `explore_data` | — | the `list_objects` → `describe_object` → `search_records` flow |
| `object_guide` | `object` | the object's descriptor (fields, relations, your permissions) + which tools to use |
| `build_filter` | `object` | the readable fields + how to shape a `search_records` filter |
| `run_workflow` | `object` | the object's workflow (states + transitions) — only for workflow objects |

Only objects the identity can read appear, and `object_guide` / `build_filter` / `run_workflow` re-check
permissions when expanded (a two-layer RBAC boundary, like the tool surface). `run_workflow` is offered
only when at least one readable object declares a workflow.

## Host provider (business prompts)

Prompts that encode *your* process (review scripts, personas, guided workflows) belong to you, not the
engine. Inject a `PromptsProvider`:

```ts
import type { PromptsProvider } from '@weave-kit/engine';

const provider: PromptsProvider = {
  list: (ctx) => (ctx.roles.includes('support') ? [{ name: 'triage_ticket', description: 'Triage a ticket' }] : []),
  get: (name, args, ctx) =>
    name === 'triage_ticket'
      ? { messages: [{ role: 'user', content: { type: 'text', text: `Triage ticket ${args.id}…` } }] }
      : null,
};

await createEngine({
  // ...
  adapters: { mcp: { prompts: { provider } } },
});
```

- `list(ctx)` returns the descriptors visible to the subject (`ctx = { subjectId, roles }`).
- `get(name, args, ctx)` expands one; return `null` for an unknown name (`prompt.notFound`).
- Both may be async. The engine treats the returned content as opaque.

**Built-in names are reserved** (`explore_data`, `object_guide`, `build_filter`, `run_workflow`): a
provider entry with one of those names is ignored, so a host cannot shadow the built-ins.

## Configure

```ts
adapters: {
  mcp: {
    prompts: {
      // enabled: true,   // default; false removes the prompts surface entirely
      // builtins: true,  // default; false keeps only the provider
      provider,           // optional business prompts
    },
  },
},
```

## Over the wire

- `prompts/list` → `{ prompts: [{ name, description?, arguments? }] }`
- `prompts/get` `{ name, arguments? }` → `{ description?, messages: [{ role, content: { type: 'text', text } }] }`

An unknown prompt name, a missing required argument, or an object outside the identity's scope is a
JSON-RPC protocol error (`InvalidParams`) — prompts are context, so failures are not tool results.

## Related

- [Tool surface](02-tool-surface.md) — the tools the built-ins teach
- [Identities](03-identities.md) — how the session identity is bound
- [Custom tools & guardrails](../03-custom-tools-and-guardrails/01-overview.md)

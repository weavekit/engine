# Custom tools, guardrails & audit replay

The engine's **open contract** lets you extend how your data is operated without touching engine code. Three mechanism-level features, off by default (nothing imported, zero runtime overhead until you opt in):

1. **Custom tools** — register your own business tools beside the generated CRUD/introspection tools.
2. **Guardrail policies** — a decision pipeline in front of every tool call (`allow` / `deny` / `requireApproval` / `mask`).
3. **Audit diff replay** — row `before`/`after` snapshots on writes for forensics and compliance.

**Where it fits.** The headline scenario is an **AI agent operating your business data over MCP** — with tools you define, governed by policies you set, and every write backed by diff-able audit evidence. It is not MCP-exclusive: the same tools run when your own application calls them through the engine host API (`engine.tools.executor`), policies gate any path that goes through the tool executor, and audit replay lives at the data-access boundary so every write — via REST, script hooks, MCP tools, or host code — is covered.

The engine ships **mechanisms only** — no business tools or policy rules are built in. Business semantics belong to your project.

## 1. Custom tools

Custom tools are TypeScript (or JS) modules that export a `ToolDefinition` as their default export. Each module becomes one tool on the engine's **per-identity tool surface** — merged with the generated CRUD/introspection tools and filtered by the identity's roles. Agents reach that surface through the MCP adapter; your own host code can invoke the same tool directly through `engine.tools.executor` (same policies, same audit).

### Configure

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

### Write a tool

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

`roles` is an **allow-list only** — the engine has no role registry, so unknown roles are simply invisible to the identities that don't list them. `roles` missing = visible to everyone.

### The controlled `ctx`

A handler receives everything it may need and nothing it shouldn't — **no raw pool / SQL / network access**:

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

### Naming rules

Tool names must match `^[a-z][a-z0-9_]*$` and must **not** collide with the generated surface: `search_ / get_ / create_ / update_ / delete_` prefixes, the `list_objects` / `describe_object` introspection tools, or the `mcp.` audit namespace. Violations fail startup with a clear error.

### Loading & production build

The loader dynamic-imports `.js / .mjs / .cjs` (and `.ts` while `tsx` is registered, i.e. under `weave dev`). For production:

- `weave build` compiles `tools/*.ts` → `dist/tools/*.js` automatically when the directory exists.
- Point `tools.toolsDir` at `dist/tools` in production config.

## 2. Guardrail policies

Policies run **before every custom-tool call** and decide whether it may proceed. Configure them inline or as a directory:

```ts
// weavekit.config.ts
import { writeProtection } from './policies';

export default {
  tools: {
    toolsDir: 'tools',
    guardrails: {
      policies: [
        { name: 'no-delete', decide: () => ({ allow: false, reason: 'deletes are prohibited' }) },
        // ... or load a directory:  policies: 'policies'  → each .js default-exports a policy
      ],
    },
  },
};
```

### Decisions

| Decision | Meaning |
| --- | --- |
| `{ allow: true }` | proceed |
| `{ allow: false, reason, errorCode? }` | deny the call (`mcp.policy.denied`) |
| `{ allow: false, requireApproval: true, approvalKey }` | suspend for human approval |
| `{ allow: true, mask: { field: '***' } }` | proceed, but replace the named **top-level fields** of the returned JSON text (non-JSON output passes through) |

A policy receives `{ actor, subject, action, args, dataAccess }` — the same controlled surface, so amount-threshold rules can read the current row:

```ts
const highValue = {
  name: 'approve-high-value',
  decide: async (ctx) => {
    const order = await ctx.dataAccess.findOne('order', ctx.args.order_id as string, { subject: ctx.subject });
    if (order !== null && Number(order.total) > 10_000) {
      return { allow: false, requireApproval: true, approvalKey: 'approve-big-order' };
    }
    return { allow: true };
  },
};
```

### Fail-closed, not fail-open

- A policy that **throws** denies the call (`mcp.policy.denied`) — fail-closed.
- A call that **no policy matches** is allowed — fail-closed applies to errors, not to absence. Without policies the pipeline is a no-op fast path.

### Approval flow (single-level gate)

1. A `requireApproval` decision suspends the call: the client gets `isError` with `mcp.approval.pending` and the `approvalKey`.
2. A host/manager approves through the queue: `await engine.tools.executor.approvals.approve(key, 'manager')`.
3. The **client retries the same call** — the gate now sees the approved key and lets it through.

The approval key is deterministic (hash of actor + action + args), so repeated calls don't duplicate pending entries. Rejection turns the retry into a deny. The queue is persisted behind a pluggable `ApprovalsBackend` (PG default; no Redis backend is implemented), and approval methods are `async`. This is a **single-level gate by design**: one call, one decision — guardrails never becomes a workflow engine.

### Order of evaluation

`rate limit → policies → execute`.

## 3. Audit diff replay

Audit events already record who did what (`weavekit_audit` — tool-call evidence like `mcp.tool.<name>` plus data-access write events). Snapshots are recorded at the **data-access write path**, so every write interface — REST, script hooks, MCP tools, and host calls — gets the same evidence. `replay` additionally snapshots the **actual row before/after** so you can reconstruct exactly what changed:

```ts
// weavekit.config.ts
export default {
  subsystems: {
    audit: {
      enabled: true,
      replay: true,     // record before/after row snapshots on update/delete
    },
  },
};
```

- `update` events carry `before` (old row) and `after` (merged row).
- `delete` events carry `before`.
- `create` needs no snapshot — `changes` is already the full inserted row.
- Snapshots reuse the row the transaction already read — **zero extra queries**.

The `weavekit_audit` table always has the `before` / `after` JSONB columns (idempotent), so toggling `replay` needs **no migration** — it only decides whether the columns are filled. Off by default to avoid storage growth; retention is a product-layer concern.

## Wiring end to end

```ts
// main.ts
import { createEngine } from '@weave-kit/engine';

const engine = await createEngine({
  databaseUrl: process.env.DATABASE_URL,
  schemaDir: '.',
  auth: { source: { 'sk-agent': { id: 'agent-1', roles: ['agent'] } } },
  adapters: { mcp: { identities: { alice: { id: 'u-alice', roles: ['agent'] } } } }, // the agent scenario
  tools: {
    toolsDir: 'tools',
    guardrails: { policies: [highValue] },
  },
  subsystems: { audit: { enabled: true, replay: true } },
});
await engine.app.listen({ port: 3000 });
// agents reach the tool surface at http://localhost:3000/mcp (MCP adapter) — alice sees reassign_ticket
// approvals: await engine.tools.executor.approvals.approve(key, 'manager')
```

The same surface works without MCP — invoke a tool from your own host code; policies and audit apply identically:

```ts
import { loadToolsDir } from '@weave-kit/engine';

const [tool] = await loadToolsDir('./tools');              // or reuse engine.tools.defs
const result = await engine.tools.executor.execute(tool.definition, { ticket_id: 'T1' }, {
  subject: { id: 'u-alice', roles: ['agent'] },
  actor: { key: 'host-app', label: 'my-service', onBehalfOf: 'alice' },
  action: 'app.tool.reassign_ticket',                     // you choose the audit action prefix
  args: { ticket_id: 'T1' },
});
```

`action` is supplied by the caller — `mcp.tool.<name>` is just the prefix the MCP binding composes; a host caller may use any prefix.

## Notes

- **Double audit is by design** — a custom tool call writes both `mcp.tool.<name>` (adapter layer) and `create/update/delete` (data-access layer). The first is the call-level evidence, the second the write-level evidence.
- Audit events (including `before`/`after`) live in PostgreSQL — **not git**. Git versions your `schema.json` metadata; business-data evidence stays in the audit table.

## Next

- [Audit](audit.md) — the write / tool-call event trail (and diff replay)
- [RBAC](rbac.md) — what shapes the generated tool surface
- [Script subsystem](script-hooks.md) — sandboxed lifecycle hooks (complementary trust model)
- [MCP](mcp.md) — the agent scenario: exposing the tool surface to AI agents

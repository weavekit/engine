---
title: Custom tools, guardrails & audit replay
description: "The open contract: register your own tools, gate them with policies, and snapshot writes for replay."
---

# Custom tools, guardrails & audit replay

The engine's **open contract** lets you extend how your data is operated without touching engine code.
Three mechanism-level features are available, and all three are off by default: until you opt in,
nothing is imported and there's zero runtime overhead.

1. **Custom tools** — register your own business tools beside the generic registry CRUD and
   introspection tools.
2. **Guardrail policies** — a decision pipeline in front of every tool call (`allow` / `deny` /
   `requireApproval` / `mask`).
3. **Audit diff replay** — row `before`/`after` snapshots on writes, for forensics and compliance.

**Where it fits.** The headline scenario is an **AI agent operating your business data over MCP**:
tools you define, governed by policies you set, with every write backed by diff-able audit evidence.
It's not MCP-exclusive. The same tools run when your own application calls them through the engine
host API (`engine.tools.executor`); policies gate any path through the tool executor; and audit replay
lives at the data-access boundary, so every write — REST, script hooks, MCP tools, or host code — is
covered.

The engine ships **mechanisms only**. No business tools or policy rules are built in; business
semantics belong to your project.

## In this section

- [Custom tools](02-custom-tools.md) — write a tool and its controlled `ctx`
- [Guardrail policies](03-guardrails.md) — decisions, approvals, fail-closed behavior
- [Audit replay](04-audit-replay.md) — before/after snapshots

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
// agents reach the tool surface at http://localhost:3000/mcp — alice sees reassign_ticket
// approvals: await engine.tools.executor.approvals.approve(key, 'manager')
```

The same surface works without MCP. Invoke a tool from your own host code and policies and audit apply
identically:

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

`action` is supplied by the caller. `mcp.tool.<name>` is just the prefix the MCP binding composes; a
host caller may use any prefix.

## Notes

- **Double audit is by design** — a custom tool call writes both `mcp.tool.<name>` (adapter layer) and
  `create/update/delete` (data-access layer). The first is call-level evidence, the second write-level.
- Audit events (including `before`/`after`) live in PostgreSQL, **not git**. Git versions your
  `schema.json` metadata ([Git-versioned metadata](../../03-model/04-git-versioned-metadata.md));
  business-data evidence stays in the audit table.

## Related

- [MCP](../02-mcp/01-overview.md) — the agent scenario: exposing the tool surface to AI agents
- [Audit](../../09-platform/03-audit.md) — the write / tool-call event trail
- [Approvals](../04-approvals.md) — the human-in-the-loop queue
- [Script subsystem](../../07-automation/02-script-hooks/01-overview.md) — complementary trust model

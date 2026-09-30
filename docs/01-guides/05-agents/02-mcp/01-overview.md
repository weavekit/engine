---
title: MCP
description: "Expose objects as agent tools over streamable HTTP, with a per-identity permission-filtered surface."
---

# MCP

MCP (Model Context Protocol) is how AI agents operate your data. The engine exposes a **streamable
HTTP** endpoint at `/mcp` (JSON-RPC 2.0): Claude, Cursor, or any MCP host connects once, then
discovers your objects as tools.

Two things make that safe:

- `tools/list` returns a **per-identity, permission-filtered** tool surface.
- `tools/call` re-enforces RBAC against the proxied user at call time.

That double layer is the point. Every attempt is also rate-limited, alertable, and audited.

MCP is an **adapter** — shared by every project type and enabled by default (`adapters.mcp`
undeclared = on).

## In this section

- [Tool surface](02-tool-surface.md) — the fixed registry of tools and how RBAC shapes it
- [Identities](03-identities.md) — the on-behalf-of directory and plugging in your own user store
- [Guardrails](04-guardrails.md) — rate limits, alerts, audit, impersonation

## Enable / configure

```ts
// weavekit.config.ts
export default {
  // ...
  adapters: {
    rest: { prefix: '/api' },
    mcp: {
      // endpoint: '/mcp/agent',   // optional: mount on a different path (default /mcp)
      identities: {
        alice: { id: 'u-alice', roles: ['sales'] },
        emma: { id: 'u-emma', roles: ['finance'], departmentId: 'd-east' },
      },
      guardrails: {
        rateLimit: { windowMs: 60_000, max: 100 },   // optional; defaults shown
        alerts: { channel: 'console' },              // console | webhook | slack
      },
    },
  },
};
```

- `endpoint` — path to mount on (default `/mcp`). Change it if `/mcp` collides with another route in
  your deployment; client URLs must match.
- `identities` — the static **on-behalf-of directory** (`ref → IdentitySubject`). See
  [Identities](03-identities.md).
- `guardrails.alerts` — any `infrastructure/alerts` factory config (webhook/slack channels reuse
  `url`/`webhookUrl`, and so on).
- `enabled: false` turns the endpoint off entirely.

## How an agent connects

1. `POST /mcp` with `Authorization: Bearer <apiKey>` and `X-Weavekit-On-Behalf-Of: <ref>`, carrying the
   `initialize` request. The engine creates a session bound to the resolved identity and returns an
   `Mcp-Session-Id` header for reuse.
2. `tools/list` returns the tool surface **compiled for that identity**. RBAC decides which operations
   appear, and each call re-checks the target object.
3. `tools/call` runs through the RBAC-decorated data-access layer against the session identity. A
   call-level `onBehalfOf` argument is an optional temporary override.

Auth failures return `401` **before** the transport is entered. A missing or unknown on-behalf-of ref
fails the session with a clear error.

## Wiring

`createEngine` wires the endpoint for you:

```ts
const engine = await createEngine({
  databaseUrl: process.env.DATABASE_URL,
  schemaDir: '.',
  auth: { source: { 'sk-agent': { id: 'agent-1', roles: ['agent'] } } },
  adapters: { mcp: { identities: { alice: { id: 'u-alice', roles: ['sales'] } } } },
});
await engine.app.listen({ port: 3000 });
// MCP endpoint: http://localhost:3000/mcp
```

You inject the sinks at assembly: audit (a buffered subsystem sink, or a no-op when audit is disabled),
alerts (`createAlerts`), and identity (`mcp.identities` — a static directory, your own
`IdentityResolver`, or the engine directory by default). The MCP adapter depends only on core
contracts; adapters never import subsystems or infrastructure.

The engine is a **bridge to your database, not a DDL runner**. `createEngine` loads the schema and
never touches your tables. Build or alter tables explicitly with `weave migrate` — see
[How migration handles existing tables](../../03-model/02-schema/05-migrations.md). (Greenfield and
business projects can set `migrate.auto: true` instead.)

## Architecture (src/adapters/mcp)

| File | Responsibility |
| --- | --- |
| `generate.ts` | RBAC capability → generic registry tool surface |
| `tools.ts` | tool execution via data-access + audit + error mapping |
| `introspection.ts` | `list_objects` / `describe_object` |
| `guardrails.ts` | sliding-window rate limit + alert/audit injection |
| `session.ts` | session model + in-memory store (TTL expiry) |
| `http.ts` | fastify `/mcp` routes; per-session SDK transport + server wiring |
| `index.ts` | `registerMcp` assembly (`EngineMcpConfig`) |

The SDK transport is stateful per session: each session owns one `StreamableHTTPServerTransport` and
one SDK `Server` (the SDK server may connect to only one transport). `tools/list` and `tools/call` are
served via `setRequestHandler`, so the surface stays dynamic per identity.

## Related

- [Tool surface](02-tool-surface.md)
- [Custom tools & guardrails](../03-custom-tools-and-guardrails/01-overview.md)
- [Audit](../../09-platform/03-audit.md) — the `mcp.tool.*` event trail
- [RBAC](../../04-access/02-rbac.md) — what shapes the tool surface
- Practice: [integrate an existing CRM](../../../03-practices/01-agent/02-existing-crm-to-mcp.md)

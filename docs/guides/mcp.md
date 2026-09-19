# MCP

The engine exposes an MCP (Model Context Protocol) **streamable HTTP** endpoint at `/mcp` (JSON-RPC 2.0). AI agents (Claude, Cursor, or any MCP host) discover and operate your objects as tools: `tools/list` returns a **per-identity, permission-filtered tool surface**, and `tools/call` re-enforces RBAC against the proxied user at call time (the double layer). Every attempt is rate-limited, alertable, and audited.

MCP is an **adapter** — like REST, it is shared by every project type and enabled by default (`adapters.mcp` undeclared = on).

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
        emma: { id: 'u-emma', roles: ['finance'], teamId: 't1' },
      },
      guardrails: {
        rateLimit: { windowMs: 60_000, max: 100 },   // optional; defaults shown
        alerts: { channel: 'console' },              // console | webhook | slack
      },
    },
  },
};
```

- `endpoint` — optional path to mount on (default `/mcp`); change it if `/mcp` collides with another route in your deployment. Client URLs must match.
- `identities` — the static **on-behalf-of directory** (`ref → RbacSubject`). A session's proxied user must resolve here; missing/unknown refs are rejected at session establishment.
- `guardrails.alerts` — any `infrastructure/alerts` factory config (webhook/slack channels reuse `url`/`webhookUrl`, etc.).
- `enabled: false` turns the endpoint off entirely.

## How an agent connects

1. `POST /mcp` with `Authorization: Bearer <apiKey>` and a `X-Weavekit-On-Behalf-Of: <ref>` header, carrying the `initialize` request → a session is created and bound to the resolved identity (the `Mcp-Session-Id` header is returned for reuse).
2. `tools/list` → the tool surface **compiled for that identity** (RBAC decides which objects and operations appear).
3. `tools/call` → runs through the RBAC-decorated data-access layer against the session identity, with call-level `onBehalfOf` argument as an optional temporary override.

Auth failures return 401 **before** entering the transport; missing/unknown `on-behalf-of` fails the session with a clear error.

## Tool surface

Per object with `read` permission, the engine compiles:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `search_<object>` | list (row scope applied) | `filter`, `sort`, `limit` (≤1000), `offset`, `fields` |
| `get_<object>` | fetch one by primary key | the object's primary-key field name (e.g. `doc_no`) |
| `create_<object>` | create (writable fields only) | `data` |
| `update_<object>` | update (RBAC `update` whitelist only) | primary-key field, `changes` |
| `delete_<object>` | delete (row scope applied) | the object's primary-key field name |

The primary-key argument is named after the schema's `primary: true` field — never hardcoded `id`. So `get_repair_order` takes `{ doc_no }` when the object's primary field is `doc_no`.

Always present:

| Tool | Purpose |
| --- | --- |
| `list_objects` | objects the identity can read (`[{ name, label }]`) |
| `describe_object` | schema + the identity's effective permissions |

Tool shaping follows RBAC exactly: an object with no listed role yields **zero** tools; `update: []` yields no `update_`; `fields.exclude` fields are stripped from parameter schemas and from results. Argument schemas are plain JSON Schema (field types map 1:1 to `string`/`number`/`integer`/`boolean`/`object`/`enum`, relations to their target primary-key type).

## Guardrails

- **Rate limiting** — per-agent-key sliding window (default 100/60s). Over-limit calls return an `isError` result and fire a `warn` alert.
- **Alerts** — injected `AlertSink` (default console; webhook/slack via config).
- **Audit** — every tool attempt writes `mcp.tool.<name>` to the unified `weavekit_audit` table (action prefix `ACTION_PREFIXES.MCP_TOOL`), including RBAC denials and failures. `actorId` = agent key, `meta` carries `{ onBehalfOf, subjectId, roles, agentLabel, tool }`. Audit is best-effort — a failing sink never blocks the tool call.

## Wiring

`createEngine` wires the endpoint automatically:

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

Sinks are injected at assembly: audit (buffered subsystem sink, or no-op when audit is disabled), alerts (`createAlerts`), identity (`mcp.identities`: a static directory or a customer-provided `IdentityResolver`). The MCP adapter itself depends only on core contracts — adapters never import subsystems/infrastructure.

For a real end-to-end walkthrough — a customer with an existing CRM (`customers` / `orders` tables) getting agents in via the static identity directory — see the [customer integration practice](../practices/existing-crm-to-mcp.md).

The engine is a **bridge to your database, not a DDL runner**: `createEngine` loads the schema and never touches your tables. Build/alter tables explicitly with `weave migrate` (or set `migrate.auto: true` for greenfield/business projects). For an existing table, `weave migrate` only validates that every declared field is a real column — it never ALTERs a table you own unless the object opts in with `"alter": true` (top-level in `schema.json`), which emits additive-only DDL (ADD COLUMN / ADD CONSTRAINT / ADD FK / CREATE INDEX).

## Plugging in your own user store

Both `auth.source` and `mcp.identities` accept either a **static map** (the defaults shown above) or a **resolver function** — so you can drive authentication and on-behalf-of identity from the customer's own users, roles and teams instead of hardcoded config.

- `auth.source` — `Record<string, RbacSubject> | AuthResolver`, where `AuthResolver = (header) => subject | null | Promise<...>`. The resolver receives the full `Authorization` header (including the `Bearer ` prefix) and may verify a JWT / look up the user asynchronously. Return `null` for unauthenticated (401).
- `mcp.identities` — `Record<string, RbacSubject> | IdentityResolver`, where `IdentityResolver = (ref) => subject | null | Promise<...>`. The resolver may query the customer's user table for the ref and return the subject with its roles/team. Return `null` for an unknown ref (session rejected with 400).

```ts
// weavekit.config.ts — auth + identities driven by the customer's user table
export default {
  schemaDir: '.',
  auth: {
    source: async (header) => {
      const token = header?.replace(/^Bearer\s+/i, '');   // verify your JWT here
      return token === undefined ? null : { id: `agent-${token}`, roles: ['agent'] };
    },
  },
  adapters: {
    mcp: {
      identities: async (ref) => {                          // query the customer's user table
        const row = await pool.query(
          `SELECT id, role, team_id FROM crm_users WHERE id = $1`, [ref]);
        if (row.rows.length === 0) return null;
        const { id, role, team_id } = row.rows[0];
        return { id, roles: [role], ...(team_id ? { teamId: team_id } : {}) };
      },
    },
  },
} satisfies EngineConfig;
```

A resolver wins over the static map when both are provided for the same field. Either way the tool surface is compiled per identity and RBAC is re-enforced at call time — the double layer never changes.

For the full runnable case (customer `crm_users` table + JWT auth source + MCP end to end) see the [user-table identity practice](../practices/bring-your-own-user-store.md).

## Architecture (src/adapters/mcp)

| File | Responsibility |
| --- | --- |
| `generate.ts` | RBAC → tool surface + JSON Schema compilation |
| `tools.ts` | tool execution via data-access + audit + error mapping |
| `introspection.ts` | `list_objects` / `describe_object` |
| `guardrails.ts` | sliding-window rate limit + alert/audit injection |
| `session.ts` | session model + in-memory store (TTL expiry) |
| `http.ts` | fastify `/mcp` routes; per-session SDK transport + server wiring |
| `index.ts` | `registerMcp` assembly (`EngineMcpConfig`) |

The SDK transport is stateful per session: each session owns one `StreamableHTTPServerTransport` + one SDK `Server` (the SDK server may connect to only one transport). `tools/list`/`tools/call` are served via `setRequestHandler` so the surface stays dynamic per identity.

## Next

- Practices & operations — integration and deployment walkthroughs
  - [Existing CRM → MCP](../practices/existing-crm-to-mcp.md) end to end
  - [Plug in your own user store](../practices/bring-your-own-user-store.md) via resolvers
  - [Docker deployment](../operations/docker-deploy.md) engine + PostgreSQL
  - [Reverse proxy + TLS](../operations/reverse-proxy.md) public agents over HTTPS
  - [MCP host setup](../practices/connecting-mcp-hosts.md) Claude Desktop / Cursor / gateway
  - [Connect an agent](../practices/connect-agent.md) local first-run (`weave dev` + `weave mcp:config`)
- [Custom tools & guardrails](custom-tools-and-guardrails.md) — custom tools + guardrail policies + audit replay
- [Audit](audit.md) — the `mcp.tool.*` event trail
- [RBAC](rbac.md) — what shapes the tool surface

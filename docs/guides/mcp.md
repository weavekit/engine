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

- `endpoint` — path to mount on (default `/mcp`). Change it if `/mcp` collides with another route in your deployment; client URLs must match.
- `identities` — the static **on-behalf-of directory** (`ref → IdentitySubject`). A session's proxied user must resolve here; a missing or unknown ref is rejected at session establishment. When unset, the engine resolves on-behalf-of refs through its own identity directory (`weavekit_user`, see [Identity](identity.md)).
- `guardrails.alerts` — any `infrastructure/alerts` factory config (webhook/slack channels reuse `url`/`webhookUrl`, and so on).
- `enabled: false` turns the endpoint off entirely.

## How an agent connects

1. `POST /mcp` with `Authorization: Bearer <apiKey>` and `X-Weavekit-On-Behalf-Of: <ref>`, carrying the `initialize` request. The engine creates a session bound to the resolved identity and returns an `Mcp-Session-Id` header for reuse.
2. `tools/list` returns the tool surface **compiled for that identity**. RBAC decides which operations appear, and each call re-checks the target object.
3. `tools/call` runs through the RBAC-decorated data-access layer against the session identity. A call-level `onBehalfOf` argument is an optional temporary override.

Auth failures return 401 **before** the transport is entered. A missing or unknown on-behalf-of ref
fails the session with a clear error.

## Tool surface

The surface is a **fixed registry** — it does not grow with the number of objects. Each capability
the identity holds on at least one object is exposed as one generic tool; the target object is an
argument:

| Tool | Purpose | Key args |
| --- | --- | --- |
| `search_records` | list an object's records (row scope applied) | `object`, `filter`, `sort`, `limit` (≤1000), `offset`, `fields` |
| `get_record` | fetch one record by record id (`weave_id`) | `object`, `id` |
| `create_record` | create (writable fields only) | `object`, `data` |
| `update_record` | update (RBAC `update` whitelist only) | `object`, `id`, `changes` |
| `delete_record` | delete (row scope applied) | `object`, `id` |
| `workflow_transition` | fire a declared [workflow](workflow.md) transition (present when the identity can update an object with a workflow) | `object`, `id`, `action` |

`object` is the object name and `id` is the record's **external id** — its `record_key`, the
length-prefixed encoding of the (possibly composite) primary key returned as the `weave_id` field.
Read it from a result (or `describe_object`) rather than composing it by hand; a `find` only returns
`weave_id` when you ask for it in `fields`. The generic schemas deliberately do **not**
enumerate per-object fields — that is what keeps the surface small — so an agent should call
`describe_object` first to learn an object's fields, relations and its own permissions. For a workflow
object, `describe_object` also returns its `workflow` (states + transitions), which `workflow_transition`
then fires by `action`.

Always present:

| Tool | Purpose |
| --- | --- |
| `list_objects` | objects the identity can read (`[{ name, labels }]`) |
| `describe_object` | schema (fields, relations, registered-type `attrs` with their spec) + the identity's effective permissions |

Tool shaping follows RBAC exactly: an operation tool appears only when the identity may perform it
on at least one object (an object with no listed role contributes nothing; `update: []` grants no
update); `fields.exclude` fields are stripped from results and rejected on write. RBAC is enforced
again per object at call time, so a field or row outside the identity's scope is rejected even when
the tool itself is present.

## Guardrails

- **Rate limiting** — per-agent-key sliding window (default 100/60s). Over-limit calls return an `isError` result and fire a `warn` alert.
- **Alerts** — injected `AlertSink` (default console; webhook/slack via config).
- **Audit** — every tool attempt writes `mcp.tool.<name>` to the unified `weavekit_audit` table (action prefix `ACTION_PREFIXES.MCP_TOOL`), including RBAC denials and failures. `actorId` is the agent key; `meta` carries `{ onBehalfOf, subjectId, roles, agentLabel, tool }`. Audit is best-effort — a failing sink never blocks the tool call.

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

You inject the sinks at assembly: audit (a buffered subsystem sink, or a no-op when audit is
disabled), alerts (`createAlerts`), and identity (`mcp.identities` — a static directory, your own
`IdentityResolver`, or the engine directory by default). The MCP adapter itself depends only on core
contracts; adapters never import subsystems or infrastructure.

For a full end-to-end walkthrough — a customer with an existing CRM (`customers` / `orders` tables)
bringing agents in through the static identity directory — see the
[customer integration practice](../practices/existing-crm-to-mcp.md).

The engine is a **bridge to your database, not a DDL runner**. `createEngine` loads the schema and
never touches your tables. Build or alter tables explicitly with `weave migrate`, and see
[How migration handles existing tables](schema.md#how-migration-handles-existing-tables) for what it
does and doesn't change. (Greenfield and business projects can set `migrate.auto: true` instead.)

## Plugging in your own user store

Both `auth.source` and `mcp.identities` accept either a **static map** (the defaults above) or a
**resolver function** — so you can drive authentication and on-behalf-of identity from your own
directory. (For a database-backed directory, prefer the engine's own identity sync — see
[Identity](identity.md) — instead of hand-writing a resolver.)

- `auth.source` — `Record<string, IdentitySubject> | AuthResolver`, where `AuthResolver = (header) => subject | null | Promise<...>`. The resolver receives the full `Authorization` header (including the `Bearer ` prefix) and may verify a JWT or look up the user asynchronously. Return `null` for unauthenticated (401). When an `identity.verifier` is configured, `auth.source` may be omitted (the verifier + engine directory authenticate instead).
- `mcp.identities` — `Record<string, IdentitySubject> | IdentityResolver`, where `IdentityResolver = (ref) => subject | null | Promise<...>`. The resolver may query your user table and return the subject with its roles and department. Return `null` for an unknown ref (the session is rejected with 400).

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
          `SELECT id, role, dept_id FROM crm_users WHERE id = $1`, [ref]);
        if (row.rows.length === 0) return null;
        const { id, role, dept_id } = row.rows[0];
        return { id, roles: [role], ...(dept_id ? { departmentId: dept_id } : {}) };
      },
    },
  },
} satisfies EngineConfig;
```

A resolver wins over the static map when both are provided for the same field. Either way, the tool
surface is compiled per identity and RBAC is re-enforced at call time — the double layer never
changes.

For the runnable case — a customer user table and a JWT auth source — see the
[user-store practice](../practices/bring-your-own-user-store.md).

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

## Next

- Practices & operations — integration and deployment walkthroughs
  - [Existing CRM → MCP](../practices/existing-crm-to-mcp.md) end to end
  - [Exposing a large schema](../practices/large-schema-agent-surface.md) — the fixed surface + discovery workflow
  - [Designing an agent-friendly schema](../practices/agent-friendly-schema.md) — labels, types, permissions
  - [Plug in your own user store](../practices/bring-your-own-user-store.md) via resolvers
  - [Docker deployment](../operations/docker-deploy.md) engine + PostgreSQL
  - [Reverse proxy + TLS](../operations/reverse-proxy.md) public agents over HTTPS
  - [MCP host setup](../practices/connecting-mcp-hosts.md) Claude Desktop / Cursor / gateway
  - [Connect an agent](../practices/connect-agent.md) local first-run (`weave dev` + `weave mcp:config`)
- [Custom tools & guardrails](custom-tools-and-guardrails.md) — custom tools + guardrail policies + audit replay
- [Audit](audit.md) — the `mcp.tool.*` event trail
- [RBAC](rbac.md) — what shapes the tool surface

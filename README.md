<h1 align="center">Let AI agents operate your data — safely</h1>

Define your data model once in `schema.json`, and WeaveKit compiles it into PostgreSQL tables, a
REST API with row- and field-level RBAC, an immutable audit log, and an MCP tool surface that AI
agents call with typed tools — never raw SQL. Self-hosted: your data stays in your database.

```
objects/leads/schema.json   →   Git commit (source of truth)
                                PostgreSQL tables + indexes + RLS
                                REST API (CRUD + RBAC)
                                MCP tools (per-identity surface + guardrails)
                                Immutable audit log
                                TypeScript types
```

## Why WeaveKit

- **Safe by construction** — every agent action is authorized by row- and field-level RBAC and
  native PostgreSQL RLS, and recorded in an immutable audit log. Guardrails (and optional
  approvals) sit in front.
- **Your model is a Git repository** — schema, hooks and policies are files you review, diff and
  revert; the engine commits every change for you, and PostgreSQL is a derived cache.
- **One agent, many users** — each MCP call carries the acting user's identity (on-behalf-of), and
  the engine compiles a per-identity tool surface: a salesperson's agent sees only their own leads,
  a finance agent cannot read sales notes. Prompt injection cannot bypass RBAC/RLS.
- **Bring your existing PostgreSQL** — point the engine at a live database and declare the tables
  you want to expose; existing tables stay read-only unless you explicitly allow additive DDL, and
  `weave introspect` can reverse-model them into `schema.json`.
- **Typed tools in minutes, not weeks** — hand-writing an MCP server (tools + permissions + audit)
  for a few tables takes days; here it is a few `schema.json` files, and new fields or tables
  extend the tool surface automatically.
- **More than MCP** — the same schema also drives a REST API and generated TypeScript types, so
  people and agents share one governed contract.
- **Self-hosted** — the engine runs in your environment; no data leaves your database.

## How it works

`weave` reads `objects/<name>/schema.json`, validates it, and syncs it to PostgreSQL (state-diff
migrations; existing tables stay read-only unless you allow additive DDL). The same metadata drives
the REST routes and the MCP tool surface, and the data-access layer enforces RBAC and audits every
write.

## Features

- **Git-versioned metadata** — schema, hooks and policies are plain files in your repository; every
  change is a scoped, atomic Git commit, so review, history and rollback come for free. PostgreSQL
  stays a derived cache.
- **Schema as the source of truth** — `objects/<name>/schema.json` drives the tables, REST API and MCP
  surface; state-diff migrations to PostgreSQL.
- **Governed REST API** — object CRUD with row-level (`all`/`own`/`team`) and field-level RBAC and a
  uniform error contract.
- **MCP tool surface** — a streamable HTTP endpoint at `/mcp` with a per-identity tool surface and
  guardrails.
- **Audit log** — an immutable event log for data mutations.
- **Sandboxed hooks** — `*.server.js` lifecycle hooks running in isolated workers.
- **Type generation** — object-level TypeScript types derived from the schema.
- **Live events** — an SSE stream with replay.
- **Operations** — health / readiness / version endpoints, request rate limiting, CORS and
  structured logging.

## Requirements

- Node.js 24 LTS
- PostgreSQL

## Quick start

```sh
npm create weavekit-app my-app -- --type=agent
cd my-app
cp .env.example .env      # set DATABASE_URL
weave migrate             # state-diff migration: schema.json → PostgreSQL tables (+ metadata cache)
weave dev                 # http://localhost:3000 — hot reload
weave types               # object-level TS types → generated/types.ts
```

**Existing database?** Reverse-model it instead of authoring from scratch:

```sh
weave introspect          # live tables → objects/<table>/schema.json (read-only)
weave schema:map          # schema field ↔ PostgreSQL column mapping + drift
```

**Connect an agent** (MCP is available at `/mcp`):

```sh
weave mcp:config          # ready-to-paste config for Claude Code / Cursor / VS Code / Claude Desktop
```

## Documentation

Full documentation: **[docs.weavekit.io/engine](https://docs.weavekit.io/engine)**

- [Getting started](https://docs.weavekit.io/engine/guides/getting-started) — scaffold, migrate, run, consume
- [Git-versioned metadata](https://docs.weavekit.io/engine/guides/git-versioned-metadata) — your data model as reviewable Git commits
- [Schema guide](https://docs.weavekit.io/engine/guides/schema) · [RBAC](https://docs.weavekit.io/engine/guides/rbac) · [Formulas](https://docs.weavekit.io/engine/guides/formulas) · [Audit](https://docs.weavekit.io/engine/guides/audit)
- [CLI reference](https://docs.weavekit.io/engine/guides/cli) · [MCP](https://docs.weavekit.io/engine/guides/mcp) · [Script hooks](https://docs.weavekit.io/engine/guides/script-hooks)
- [Custom tools & guardrails](https://docs.weavekit.io/engine/guides/custom-tools-and-guardrails) · [Quotas](https://docs.weavekit.io/engine/guides/quotas) · [Inbound events](https://docs.weavekit.io/engine/guides/ingress)
- [Public API & dependency budget](https://docs.weavekit.io/engine/reference/public-api)
- [Practices & operations](https://docs.weavekit.io/engine/practices/existing-crm-to-mcp) — real integration and deployment walkthroughs

The Markdown sources live in [`docs/`](https://github.com/weavekit/engine/tree/main/docs).

## Programmatic use

```ts
import { createEngine } from '@weave-kit/engine';

const engine = await createEngine({
  databaseUrl: process.env.DATABASE_URL,
  schemaDir: '.', // project root containing objects/
  auth: { source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } },
});
await engine.app.listen({ port: 3000 });
```

## Metadata

- **Objects** live in `objects/<name>/schema.json` (one directory per object; the directory name must
  equal the object name).
- **`weavekit.config.ts`** is the single wiring point — a default export `satisfies EngineConfig`
  (`schemaDir`, `auth`, `adapters`, `subsystems`).
- `schema.json` is versioned in Git and is the source of truth; the engine syncs it to PostgreSQL and
  a metadata cache.

## CLI

| Command | Description |
| --- | --- |
| `weave migrate [--dry-run]` | State-diff migration + metadata cache + auto-commit |
| `weave dev [--port]` | Run with hot reload |
| `weave build` | Bundle the server entry (esbuild) |
| `weave test` | Proxy the project test suite |
| `weave types [--outdir]` | Compile `schema.json` into object-level TS types |
| `weave introspect` | Reverse-model an existing Postgres DB into `objects/*/schema.json` |
| `weave schema:map [object] [--drift]` | Report the schema field ↔ PostgreSQL column mapping |
| `weave schema:upgrade [--dry-run]` | Upgrade `objects/*/schema.json` to the current format version |
| `weave openapi [--out] [--generic] [--server]` | Emit an OpenAPI 3.1 document for the REST API |
| `weave mcp:config [--host]` | Print MCP client config for this project's `/mcp` endpoint |
| `weave connect` | Connect a self-hosted engine out to a governance tunnel endpoint |
| `weave object:create <name>` | Scaffold `objects/<name>/schema.json` + `server.js` hooks |
| `weave field:add <object>` | Add a validated field to a schema |
| `weave module:add` / `module:remove <name>` | Enable/disable an optional subsystem (audit/script) |

## Object-level types

```sh
weave types   # → generated/types.ts
```

```ts
import type { Lead } from './generated/types';
import { createClient } from '@weave-kit/client';

const leads = createClient({ baseUrl, apiKey }).objects<Lead>('lead');
const { rows } = await leads.find({ filter: { status: 'open' } });
```

## Development

```sh
npm install
npm run build        # tsc → dist
npm test             # unit + e2e (e2e needs DATABASE_URL)
npm run typecheck
npm run lint
```

Issues and pull requests are welcome. See [`AGENTS.md`](AGENTS.md) for architecture notes and
contribution invariants.

## Support

Questions, bug reports and security reports: **support@weavekit.io**.

## License

[MIT](LICENSE) · For support, contact **support@weavekit.io**.

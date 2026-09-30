---
description: "Take a project from empty to running: scaffold it, migrate the schema to PostgreSQL, run with hot reload, generate types, and call the API."
---

# Getting started

This page takes you end to end: define a data model in `schema.json`, migrate it to PostgreSQL, run
the engine with hot reload, generate TypeScript types, and consume the API from `@weave-kit/client`.

## Prerequisites

- **Node 24+**
- **PostgreSQL** reachable at a `DATABASE_URL` connection string

## 1. Scaffold a project

```sh
create-weavekit-app my-app --type=agent
cd my-app
```

Or run `create-weavekit-app my-app --yes` to skip all prompts. The command generates:

```
weavekit.config.ts             # engine wiring (schemaDir, auth, adapters)
objects/leads/schema.json      # leads example object with RBAC (admin/sales/sales_manager roles)
main.ts                        # server entry (createEngine + listen)
package.json                   # scripts delegate to `weave`
.env.example                   # DATABASE_URL placeholder
.gitignore
```

## 2. Configure the database

```sh
cp .env.example .env       # set DATABASE_URL=postgres://user:pass@host:5432/db
```

The engine reads `DATABASE_URL` from the project environment. `weavekit.config.ts` does **not** need
to repeat it.

## 3. Migrate metadata to PostgreSQL

```sh
weave migrate               # state-diff DDL: schema.json → PG tables
weave migrate --dry-run     # preview the DDL without executing
```

Migration is **state-diff** and idempotent: it compares the expected schema against
`information_schema` and emits only the `CREATE` / `ALTER` statements it needs. Every sync writes an
audit trail, updates the PG metadata cache, and auto-commits the `objects/` tree to Git — see
[Git-versioned metadata](03-model/04-git-versioned-metadata.md).

Existing tables are treated carefully — see
[How migration handles existing tables](03-model/02-schema/05-migrations.md) for the
read-only default and the additive-only `"alter": true` opt-in.

## 4. Run with hot reload

```sh
weave dev                   # http://localhost:3000
```

`weave dev` syncs Git → PG on every reload, starts the REST API, and **watches `objects/`**. Editing a
`schema.json` reloads the schema, regenerates types, and rebuilds the app. Objects with
`"alter": true` get additive DDL applied on reload; a change that would touch a read-only existing
table rejects the reload, keeps the running engine on the previous schema, and emits a `schema.drift`
event to connected frontends.

Try it:

```sh
curl -H "Authorization: Bearer sk-admin" \
  "http://localhost:3000/api/objects/leads"
# {"rows":[],"total":0,"limit":100,"offset":0}

curl -X POST -H "Authorization: Bearer sk-admin" -H "Content-Type: application/json" \
  -d '{"id":"e1","title":"Hello","company":"Acme","amount":100}' \
  "http://localhost:3000/api/objects/leads"
# `sk-admin` maps to the `admin` role (full permissions), so the create succeeds.
```

Point an AI agent at the same process — MCP is already on at `http://localhost:3000/mcp`. Print
ready-to-paste config for Claude Code / Cursor / VS Code / Claude Desktop:

```sh
weave mcp:config
```

See [connect an agent](../03-practices/01-agent/04-connect-agent.md) for the 5-minute walkthrough.

## 5. Generate object-level TypeScript types

```sh
weave types                 # → generated/types.ts
```

Every object becomes a TS interface — field types, enum unions, and relation primary-key types are
derived from the schema.

## 6. Consume from the client SDK

```ts
import { createClient } from '@weave-kit/client';
import type { Leads } from './generated/types';

const client = createClient({ baseUrl: 'http://localhost:3000', apiKey: 'sk-admin' });
const leads = client.objects<Leads>('leads');

const { rows, total } = await leads.find({ filter: { status: 'active' }, fields: ['id', 'weave_id'] });
const id = String(rows[0]!.weave_id);        // the record_key (e.g. '2:e1') — the external id
const one = await leads.findOne(id);         // null on 404
await leads.update(id, { title: 'Renamed' });
await leads.delete(id);
```

> The external id is the `record_key` (returned as the read-only `weave_id` field), not the raw
> primary-key value — request `weave_id` in `fields` and pass it back (see [Schema](03-model/02-schema/01-overview.md#record-ids-and-system-fields)).

## Programmatic assembly

Instead of the CLI, you can assemble an engine directly:

```ts
import { createEngine } from '@weave-kit/engine';

const engine = await createEngine({
  databaseUrl: process.env.DATABASE_URL,
  schemaDir: '.',                        // project root containing objects/
  auth: { source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } },
  adapters: { rest: { enabled: true, prefix: '/api' } },
});
await engine.app.listen({ port: 3000 });
```

### Production: two database accounts

WeaveKit runs DDL only through `weave migrate`; the runtime only runs DML. Use **two accounts on the
same database** (not two databases) — a runtime role with no DDL, and an owner role for migrations —
so a compromised runtime cannot change the schema:

```ts
const engine = await createEngine({
  // same host/port/dbname for both; only the role differs
  databaseUrl: process.env.DATABASE_URL,                    // runtime role: no CREATE
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL, // owner role: DDL via `weave migrate`
  schemaDir: '.',
  auth: { source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } },
});
```

```
DATABASE_URL=postgres://weavekit_runtime:pw@localhost:5432/weavekit
MIGRATION_DATABASE_URL=postgres://weavekit_owner:pw@localhost:5432/weavekit
```

Run `weave migrate` once (with `MIGRATION_DATABASE_URL`) before the first boot — it provisions the
customer tables **and** the engine's own `weavekit_*` system tables. By default the engine refuses to
start if the runtime account can `CREATE` (`runtime.requireRestrictedAccount`; set it to `false`, or
`WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT=false`, for a single-account setup).

## Related
- [Schema guide](03-model/02-schema/01-overview.md) — objects, fields, relations
- [RBAC](04-access/02-rbac.md) — permissions, row scopes, field exclusions
- [Formulas](03-model/03-formulas.md) — computed fields
- [Audit](09-platform/03-audit.md) — immutable event logging
- [CLI reference](09-platform/02-cli.md) — every `weave` command
- [MCP](05-agents/02-mcp/01-overview.md) — expose objects as agent tools; [connect an agent](../03-practices/01-agent/04-connect-agent.md) locally

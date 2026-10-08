---
title: "CLI reference (`weave`)"
description: "weave is the single entry point for project workflows."
---
# CLI reference (`weave`)

`weave` is the single entry point for project workflows. Run it from your project root. Every command
accepts `--json` for machine-readable output.

| Command | Description |
| --- | --- |
| `weave migrate` | Sync metadata to PostgreSQL |
| `weave deploy plan` | Preview the schema/DB changes for the next deploy (read-only) |
| `weave deploy apply` | Apply the changes atomically and record a schema revision |
| `weave dev` | Run with hot reload |
| `weave build` | Bundle the app entry |
| `weave test` | Proxy `node --test` |
| `weave types` | Generate object-level TS types |
| `weave introspect` | Reverse-model an existing Postgres DB into `objects/*/schema.json` |
| `weave mcp:config` | Print ready-to-paste config connecting an MCP host |
| `weave connect` | Dial a self-hosted engine out to a governance tunnel endpoint |
| `weave schema:map [object]` | Report the schema field ↔ PostgreSQL column mapping |
| `weave schema:upgrade [--dry-run]` | Upgrade `objects/*/schema.json` to the current format version |
| `weave openapi [--out <file>] [--generic] [--server <url>]` | Emit an OpenAPI 3.1 document for the REST API |
| `weave graphql:schema [--out <file>]` | Emit the GraphQL SDL for this project |
| `weave object:create <name>` | Scaffold an object (schema.json + server.js hooks) |
| `weave field:add <object>` | Add a field to an object's schema.json |
| `weave field-type:list` | List built-in + registered field types |
| `weave field-type:check` | Validate registrations + schemas against the registry |
| `weave enum:list` | List declared named enums (`enums/<name>.json`) |
| `weave enum:check` | Validate enum declarations + schema references |
| `weave module:add <name>` | Enable a subsystem (audit/script/workflow) in weavekit.config.ts |
| `weave module:remove <name>` | Disable a subsystem (audit/script/workflow) in weavekit.config.ts |
| `weave workflow:open <object>` | Enable the object workflow (scaffolds `workflow.json` + sets `workflowEnabled`) |
| `weave workflow:close <object>` | Disable the object workflow (keeps workflow.json) |
| `weave workflow:upgrade` | Upgrade `objects/*/workflow.json` to the current format version |
| `weave sync:identity [--dry-run]` | Provision the engine identity directory from the configured `identity.source` |
| `weave identity:list` | List engine-owned identities (greenfield admin) |
| `weave identity:create <name>` | Create an engine-owned identity (greenfield admin) |
| `weave identity:enable <id>` / `weave identity:disable <id>` | Enable / disable an identity |

## `create-weavekit-app` — project scaffolding

`create-weavekit-app` creates a new project (create-next-app style). It is installed globally
alongside `@weave-kit/engine`:

```sh
create-weavekit-app my-app --yes                # one line, all defaults (name required)
create-weavekit-app my-app                      # prompts for type preset + git init
create-weavekit-app                             # prompts for the project name too
```

- `--type agent|governance|service|business` — starting-preset narrative (default `agent`).
- `--no-git` — skip `git init`.
- `--force` — overwrite existing files.
- Project name is validated against npm package-name rules.

The generated project contains `weavekit.config.ts`, `main.ts` (the app entry),
`objects/leads/schema.json`, `.env.example`, `.gitignore`, `package.json`, and `README.md`.

## `weave migrate [--dry-run]`

One-way Git → PostgreSQL sync: load `schema.json` files → validate → state-diff migration → write the
metadata cache → auto-commit the `objects/` tree ([Git-versioned metadata](../03-model/04-git-versioned-metadata.md)).

- `--dry-run` — generate DDL and report without executing.
- Runs against `migrationDatabaseUrl` (falling back to `databaseUrl`). This is the **same database,
  a separate account** — a migration/owner role with DDL rights — so the runtime account can be
  given no DDL. The engine never runs DDL at runtime.
- Also provisions the engine's own system tables (`weavekit_metadata`, `weavekit_schema_revision`,
  `weavekit_seq`, `weavekit_audit`, `weavekit_audit_outbox`, `weavekit_approvals`,
  `weavekit_workflow_timers`, `weavekit_counters`, `weavekit_meta`) and their row-level security. Run
  it at least once before the first boot; the runtime account can then be least-privileged
  (`runtime.requireRestrictedAccount`, default on).
- Existing tables are validated **read-only** by default. A declared field with no matching column
  aborts with `object.field.columnMissing`. An object opts into additive auto-DDL with `"alter": true`
  in its `schema.json`. See
  [How migration handles existing tables](../03-model/02-schema/05-migrations.md).

## `weave deploy plan` / `weave deploy apply`

A deployment-oriented view of the same schema sync. Both run against
`migrationDatabaseUrl` (falling back to `databaseUrl`):

- `weave deploy plan` — **read-only** preview of the DDL the next apply would run, the objects that
  would change, the aggregate **schema hash**, and a coarse risk level (`low` / `medium` / `high`).
- `weave deploy apply` — applies the changes **atomically**: the DDL, the metadata cache and a global
  **schema revision** (`weavekit_schema_revision`) commit in one transaction, serialized by an
  advisory lock. A failure rolls everything back (no partial deploy). Prints the new revision id
  (`(unchanged)` when the content hash already exists — re-applying the same schema writes no new
  revision).

`weave migrate` is the day-to-day command (it also auto-commits the `objects/` tree); `weave deploy`
is the explicit, revision-recording path for release jobs. See
[How migration handles existing tables](../03-model/02-schema/05-migrations.md).

## `weave dev [--port <n>]`

Loads the schema, syncs Git → PG (per-object `alter`), starts the REST API (default
`http://localhost:3000`), and **hot-reloads** on `schema.json` changes: sync → regenerate
`generated/types.ts` → rebuild the app.

Objects with `"alter": true` get additive DDL applied on reload. A change that would touch a read-only
existing table rejects the reload, keeps the running engine on the previous schema, and emits a
`schema.drift` event.

- `--port` — HTTP port (default `3000`).

## `weave build [--entry <file>]`

Bundles the app entry (`main.ts` by default — the file that calls `createEngine` and `listen`) into
`dist/` with esbuild (`--target=node24`).

- `--entry` — alternate entry file (default `main.ts`).

## `weave test [-- <node test args>]`

Runs the project test suite by proxying the Node.js test runner (`node --test`). Arguments after `--`
are forwarded, and the exit code is propagated.

## `weave types [--outdir <dir>]`

Compiles `schema.json` into object-level TypeScript interfaces.

- Writes `generated/types.ts` by default (or `--outdir`).
- Commits the generated file to git.
- Re-run after schema changes, or let `weave dev` regenerate automatically.

## `weave introspect [--out <dir>] [--include <tables>] [--exclude <tables>] [--force] [--dry-run] [--no-commit]`

The inverse of `migrate`: read an **existing** PostgreSQL schema and write
`objects/<table>/schema.json` for each table, ready to serve over REST/MCP or edit by hand.

- Generated objects default to `"alter": false` — the command is read-only and never touches your database.
- Every generated schema passes `validateObject` before it is written; skipped tables and suggestions are reported.
- `--include` / `--exclude` take comma-separated table names; `--out` overrides the output directory (default `<schemaDir>/objects`).
- `--force` overwrites existing `objects/<name>/schema.json`; without it, existing files are kept.
- `--dry-run` reports without writing; `--no-commit` skips the auto-commit.

## `weave mcp:config [--host <host>] [--url <url>] [--port <n>] [--key <key>] [--identity <ref>]`

Prints ready-to-paste client configuration for connecting an MCP host to this project's `/mcp`
endpoint. The endpoint is derived from `mcp.endpoint` + `--port` (default `3000`); the key defaults to
the first static key in `auth.source`, and the on-behalf-of identity to the first ref in
`mcp.identities`.

- `--host` — one of `claude-code`, `claude-desktop`, `cursor`, `vscode`, `stdio`, `curl` (default: all).
- `--json` — emit the snippets as structured JSON.
- See [MCP host setup](../../03-practices/01-agent/03-connecting-mcp-hosts.md) for deployed hosts and [connect an agent](../../03-practices/01-agent/04-connect-agent.md) for the local walkthrough.

## `weave connect --endpoint <url> --tunnel <id> --token <token> --engine <url> --api-key <key> [--insecure]`

Connects a self-hosted, NAT'd or on-prem engine **out** to a governance tunnel endpoint, so the
governance side can reach it without a routable URL. The command dials a persistent HTTP/2 `CONNECT`
stream and stays up until `Ctrl+C`; the local engine is left untouched, and only the requests the
governance side sends are forwarded (the connector only ever calls the engine on localhost).

- `--endpoint <url>` — governance tunnel endpoint (h2c `http://…` or TLS `https://…`).
- `--tunnel <id>` — the `connections.tunnel_id` this engine is paired under.
- `--token <token>` — the `connections.pairing_token` used to authenticate the `CONNECT` handshake.
- `--engine <url>` — the local engine base URL to forward to (e.g. `http://localhost:3000`).
- `--api-key <key>` — required; the API key the connector uses to call the local engine.
- `--insecure` — skip TLS certificate verification (dev / self-signed).

The governance side accepts the stream, registers the session by `tunnel_id`, and routes proxied
requests over it (a proxy target with `transport: "tunnel"`); responses, including server-sent
events, stream back. This is the customer-side half of the tunnel transport — the primitives
(`connectTunnel`, `createTunnelServer`) are exported from the stable API
(see [public API](../../04-reference/01-api/02-public-api.md)).

## `weave schema:map [object] [--drift]`

A read-only report pairing every declared schema field with its PostgreSQL column: the expected type
and constraints, plus the live column state when the table exists. It requires a database connection
and never emits DDL or writes.

- `weave schema:map` — every object as one report (a table per object).
- `weave schema:map <object>` — one table, with its indexes, foreign keys, table-level UNIQUE
  constraints, and RLS/owner state.
- `--drift` — show only drifting columns and tables (what `weave migrate` would change).
- `--json` — the structured report.

Per column it shows `field`, the schema type (`relation → target.pk`, `enum[n]`), the column name, the
expected PG type, constraints (`PK` / `NOT NULL` / `UNIQUE` / `DEFAULT …` / `FK → …`), and a `db`
status: `ok`, `missing`, `type: <actual>`, `null: …`, or `extra (…)` for a live column that isn't in
the schema. Objects that are `details` children also list their engine-managed `parent_id` /
`parent_type` / `parent_idx` columns.

Tables that declare composite/scoped `constraints` also print a `unique:` line — each constraint's
name, its columns, and `MISSING` when the backing unique index/constraint is absent. The footer
totals include `constraint drift` alongside index and FK drift.

## `weave schema:upgrade [--dry-run]`

Brings every `objects/<name>/schema.json` up to the current on-disk format version (see the
[schema guide](../03-model/02-schema/01-overview.md#format-version)). Unversioned legacy files are stamped with the current
`schemaVersion`; a file declaring a newer version aborts. `--dry-run` reports what would change
without writing; a real run rewrites the files and auto-commits the metadata tree.

## `weave openapi [--out <file>] [--generic] [--server <url>]`

Writes an **OpenAPI 3.1** document describing this project's REST API — no database needed. Object
routes are documented generically (`{name}` is an object from your `schema.json`), and each object
also gets `<name>`, `<name>Create` and `<name>Update` component schemas for client generation. Only
the route groups enabled by your config are included (audit, approvals, guardrails, proxy, ingress,
events).

- `--out <file>` — output path (default `openapi.json`); `--out -` prints to stdout.
- `--generic` — omit the per-object component schemas (used for a generic reference).
- `--server <url>` — the `servers[].url` (default `http://localhost:3000`).

Feed the file to Swagger UI, or generate a typed client with any OpenAPI code generator. The stable
API equivalent is `buildOpenApiDocument()` (see [public API](../../04-reference/01-api/02-public-api.md)).

## `weave graphql:schema [--out <file>]`

Writes the **GraphQL SDL** compiled from this project's objects — no database needed. With `--out -`
(or no `--out`) it prints to stdout; otherwise it writes the file. Useful for client codegen or review.
The endpoint itself is opt-in via `adapters.graphql.enabled` — see [GraphQL](../08-integration/06-graphql.md).

## `weave object:create <name>`

Scaffolds a new object: `objects/<name>/schema.json` (primary key + title field) plus
`objects/<name>/server.js`, the sandboxed lifecycle-hook template. The metadata tree is
auto-committed.

- Name must be `snake_case`.
- Requires the script subsystem ([script hooks](../07-automation/02-script-hooks/01-overview.md)) to execute the hooks.

## `weave field:add <object>`

Adds a field to `objects/<name>/schema.json` and auto-commits:

- `--name <field>` `--type <type>` (required); `--required`, `--unique`, `--default <value>`, `--options a,b,c` (inline enum), `--options-from <object[.column]>` (data-driven enum) or `--enum <name>` (a [named enum](../03-model/02-schema/06-named-enums.md) declared in `enums/<name>.json`), `--target <object>` (relation/multiRelation).
- The whole updated schema is validated before writing (enum options, relation target, snake_case enforced).

## `weave field-type:list`

Prints the effective field-type surface: every built-in type plus the project's registrations, each
with its source (`builtin` or `field-types/<file>`), inherited `base`, and flags (`scalar`,
`relationLike`, `visual:…`, `format:…`, `reverse`, `storage`, `validate`,
`attrs:<name>|<name>`). `--json` emits the structured list.

## `weave field-type:check`

Validates the field-type setup without a database and exits non-zero on any problem:

- registrations load + validate (namespaced name, allowed `base`, no collisions);
- every `features.fieldTypes` entry resolves to a built-in or registered type (catches typos);
- every `objects/<name>/schema.json` loads against the effective registry (catches unregistered /
  disabled field types).

Use it in CI to fail early when a schema references a type the project doesn't provide. See
[Custom field types](../../04-reference/02-schema/02-custom-field-types.md).

## `weave enum:list`

Prints the declared named enums (`enums/<name>.json`) — each with its values, the locales that carry
per-value labels, and its source file. `--json` emits the structured list.

## `weave enum:check`

Validates the named-enum setup without a database and exits non-zero on any problem:

- every `enums/<name>.json` declaration parses and is valid (snake_case name, non-empty unique values,
  labels keyed to declared values);
- every `objects/<name>/schema.json` loads against the declarations (catches an unresolved `enumType`
  and inline options that disagree with the declaration).

Use it in CI alongside `weave field-type:check`. See [Named enums](../03-model/02-schema/06-named-enums.md).

## `weave module:add <name>` / `weave module:remove <name>`

Enables or disables a subsystem (`audit`, `script` or `workflow`) in `weavekit.config.ts` — the config
stays the source of truth — and auto-commits. Any other name is rejected. If the config shape is
unrecognized, the command tells you to edit manually instead of corrupting the file.

Note: the `workflow` subsystem only runs the `onTimeout` timer scheduler. The state machine itself is
declaration-driven (a `workflowEnabled` object with a `workflow.json`) and needs no subsystem.

## `weave workflow:open <object>`

Enables the object's workflow by setting `"workflowEnabled": true` in its `schema.json` and
auto-commits. When no `workflow.json` exists it scaffolds a starter single-line node chain (one
`review` node):

- `--roles a,b` — roles whose members become the starter node's assignees (default `approver`).

If the definition file already exists but is disabled, it is simply re-enabled (the definition is
kept as-is). The schema + workflow are validated before writing. The workflow never adds a field to
the customer table.

## `weave workflow:close <object>`

Sets `"workflowEnabled": false` and auto-commits. `workflow.json` is kept; the workflow routes `404`
until re-enabled with `weave workflow:open`.

## `weave workflow:upgrade [--dry-run]`

Brings every `objects/<name>/workflow.json` up to the current on-disk format version and auto-commits
(independent of `weave schema:upgrade`, which never touches `workflow.json`). Legacy state-machine
files are migrated and stamped with the current `schemaVersion`; an unversioned `nodes[]` file is
already current and left untouched; future/unsupported versions abort.

## `weave sync:identity [--dry-run]`

Provisions the engine identity directory (`weavekit_user` / `weavekit_department`) from the
`identity.source` in `weavekit.config.ts` (a `pg` descriptor or a function source). It is **read-only
against the source tables** and idempotent (upsert on `(source, external_id)`), with department-cycle
detection and optional soft-disable of rows missing from the snapshot. See [Identity](../04-access/03-identity.md).

- `--dry-run` — pull + diff the counts without writing.

## `weave identity:list` / `identity:create <name>` / `identity:enable|disable <id>`

Greenfield administration of engine-owned identities (for projects with no external source): list,
create (`--email`, `--roles a,b`, `--disabled`), and enable/disable. The same data is exposed by the
admin REST surface `GET` / `POST /api/identity/users` and `PATCH /api/identity/users/:id`
(gated by `adapters.rest.adminRoles`).

# CLI reference (`weave`)

`weave` is the single entry point for project workflows. Run it from your project root. Every command
accepts `--json` for machine-readable output.

| Command | Description |
| --- | --- |
| `weave migrate` | Sync metadata to PostgreSQL |
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
| `weave object:create <name>` | Scaffold an object (schema.json + server.js hooks) |
| `weave field:add <object>` | Add a field to an object's schema.json |
| `weave field-type:list` | List built-in + registered field types |
| `weave field-type:check` | Validate registrations + schemas against the registry |
| `weave module:add <name>` | Enable a subsystem (audit/script) in weavekit.config.ts |
| `weave module:remove <name>` | Disable a subsystem (audit/script) in weavekit.config.ts |

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
metadata cache → auto-commit the `objects/` tree ([Git-versioned metadata](git-versioned-metadata.md)).

- `--dry-run` — generate DDL and report without executing.
- Existing tables are validated **read-only** by default. A declared field with no matching column
  aborts with `object.field.columnMissing`. An object opts into additive auto-DDL with `"alter": true`
  in its `schema.json`. See
  [How migration handles existing tables](schema.md#how-migration-handles-existing-tables).

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
- See [MCP host setup](../practices/connecting-mcp-hosts.md) for deployed hosts and [connect an agent](../practices/connect-agent.md) for the local walkthrough.

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
(see [public API](../reference/public-api.md)).

## `weave schema:map [object] [--drift]`

A read-only report pairing every declared schema field with its PostgreSQL column: the expected type
and constraints, plus the live column state when the table exists. It requires a database connection
and never emits DDL or writes.

- `weave schema:map` — every object as one report (a table per object).
- `weave schema:map <object>` — one table, with its indexes, foreign keys, and RLS/owner state.
- `--drift` — show only drifting columns and tables (what `weave migrate` would change).
- `--json` — the structured report.

Per column it shows `field`, the schema type (`relation → target.pk`, `enum[n]`), the column name, the
expected PG type, constraints (`PK` / `NOT NULL` / `UNIQUE` / `DEFAULT …` / `FK → …`), and a `db`
status: `ok`, `missing`, `type: <actual>`, `null: …`, or `extra (…)` for a live column that isn't in
the schema. Objects that are `details` children also list their engine-managed `parent_id` /
`parent_type` / `parent_idx` columns.

## `weave schema:upgrade [--dry-run]`

Brings every `objects/<name>/schema.json` up to the current on-disk format version (see the
[schema guide](schema.md#format-version)). Unversioned legacy files are stamped with the current
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
API equivalent is `buildOpenApiDocument()` (see [public API](../reference/public-api.md)).

## `weave object:create <name>`

Scaffolds a new object: `objects/<name>/schema.json` (primary key + title field) plus
`objects/<name>/server.js`, the sandboxed lifecycle-hook template. The metadata tree is
auto-committed.

- Name must be `snake_case`.
- Requires the script subsystem ([script hooks](script-hooks.md)) to execute the hooks.

## `weave field:add <object>`

Adds a field to `objects/<name>/schema.json` and auto-commits:

- `--name <field>` `--type <type>` (required); `--required`, `--unique`, `--default <value>`, `--options a,b,c` (enum), `--target <object>` (relation/multiRelation).
- The whole updated schema is validated before writing (enum options, relation target, snake_case enforced).

## `weave field-type:list`

Prints the effective field-type surface: every built-in type plus the project's registrations, each
with its source (`builtin` or `field-types/<file>`), inherited `base`, and flags (`scalar`,
`relationLike`, `visual:…`, `format:…`, `reverse`). `--json` emits the structured list.

## `weave field-type:check`

Validates the field-type setup without a database and exits non-zero on any problem:

- registrations load + validate (namespaced name, allowed `base`, no collisions);
- every `features.fieldTypes` entry resolves to a built-in or registered type (catches typos);
- every `objects/<name>/schema.json` loads against the effective registry (catches unregistered /
  disabled field types).

Use it in CI to fail early when a schema references a type the project doesn't provide. See
[Custom field types](../reference/custom-field-types.md).

## `weave module:add <name>` / `weave module:remove <name>`

Enables or disables a subsystem (currently `audit` or `script`) in `weavekit.config.ts` — the config
stays the source of truth — and auto-commits. Unknown subsystems (e.g. `workflow`) are rejected. If
the config shape is unrecognized, the command tells you to edit manually instead of corrupting the
file.

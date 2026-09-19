# CLI reference (`weave`)

`weave` is the single entry point for project workflows. Run it from your project root. All commands accept `--json` for machine-readable output.

| Command | Description |
| --- | --- |
| `weave migrate` | Sync metadata to PostgreSQL |
| `weave dev` | Run with hot reload |
| `weave build` | Bundle the app entry |
| `weave test` | Proxy `node --test` |
| `weave types` | Generate object-level TS types |
| `weave introspect` | Reverse-model an existing Postgres DB into `objects/*/schema.json` |
| `weave mcp:config` | Print ready-to-paste config connecting an MCP host |
| `weave schema:map [object]` | Report the schema field ↔ PostgreSQL column mapping |
| `weave schema:upgrade [--dry-run]` | Upgrade `objects/*/schema.json` to the current format version |
| `weave object:create <name>` | Scaffold an object (schema.json + server.js hooks) |
| `weave field:add <object>` | Add a field to an object's schema.json |
| `weave module:add <name>` | Enable a subsystem (audit/script) in weavekit.config.ts |
| `weave module:remove <name>` | Disable a subsystem (audit/script) in weavekit.config.ts |

## `create-weavekit-app` — project scaffolding

Create a new project with the `create-weavekit-app` command (create-next-app style). It is installed globally alongside `@weave-kit/engine`:

```sh
create-weavekit-app my-app --yes                # one line, all defaults (name required)
create-weavekit-app my-app                      # prompts for type preset + git init
create-weavekit-app                             # prompts for the project name too
```

- `--type agent|governance|service|business` — starting-preset narrative (default `agent`).
- `--no-git` — skip `git init`.
- `--force` — overwrite existing files.
- Project name is validated against npm package-name rules.

The generated project contains `weavekit.config.ts`, `main.ts` (the app entry), `objects/leads/schema.json`, `.env.example`, `.gitignore`, `package.json`, and `README.md`.

## `weave migrate [--dry-run]`

One-way Git → PostgreSQL sync: load `schema.json` files → validate → state-diff migration → write the metadata cache → auto-commit the `objects/` tree.

- `--dry-run` — generate DDL and report without executing.
- Existing tables are validated **read-only** by default (a missing declared field aborts with `object.field.columnMissing`). An object opts into additive auto-DDL with `"alter": true` in its `schema.json` — ADD COLUMN / ADD CONSTRAINT / ADD FK / CREATE INDEX, never altering column types or dropping columns.

## `weave dev [--port <n>]`

Loads the schema, syncs Git → PG (per-object `alter`), starts the REST API (default `http://localhost:3000`), and **hot-reloads** on `schema.json` changes: sync → regenerate `generated/types.ts` → rebuild the app. Objects with `"alter": true` get additive DDL applied on reload; a change that would touch a read-only existing table rejects the reload, keeps the running engine on the previous schema, and pushes a `schema.drift` event.

- `--port` — HTTP port (default `3000`).

## `weave build [--entry <file>]`

Bundles the app entry (`main.ts` by default — the file that calls `createEngine` and `listen`) into `dist/` with esbuild (`--target=node24`).

- `--entry` — alternate entry file (default `main.ts`).

## `weave test [-- <node test args>]`

Runs the project test suite by proxying the Node.js test runner (`node --test`); arguments after `--` are forwarded. Exit code is propagated.

## `weave types [--outdir <dir>]`

Compiles `schema.json` into object-level TypeScript interfaces.

- Writes `generated/types.ts` by default (or `--outdir`).
- Commits the generated file to git.
- Re-run after schema changes (or let `weave dev` regenerate automatically).

## `weave introspect [--out <dir>] [--include <tables>] [--exclude <tables>] [--force] [--dry-run] [--no-commit]`

The inverse of `migrate`: read an **existing** PostgreSQL schema and write `objects/<table>/schema.json` for each table, ready to serve over REST/MCP or edit by hand.

- Generated objects default to `"alter": false` — the command is read-only and never touches your database.
- Every generated schema passes `validateObject` before it is written; skipped tables and suggestions are reported.
- `--include`/`--exclude` take comma-separated table names; `--out` overrides the output directory (default `<schemaDir>/objects`).
- `--force` overwrites existing `objects/<name>/schema.json`; without it, existing files are kept.
- `--dry-run` reports without writing; `--no-commit` skips the auto-commit.

## `weave mcp:config [--host <host>] [--url <url>] [--port <n>] [--key <key>] [--identity <ref>]`

Prints ready-to-paste client configuration for connecting an MCP host to this project's `/mcp` endpoint — the endpoint is derived from `mcp.endpoint` + `--port` (default `3000`), the key defaults to the first static key in `auth.source`, and the on-behalf-of identity to the first ref in `mcp.identities`.

- `--host` — one of `claude-code`, `claude-desktop`, `cursor`, `vscode`, `stdio`, `curl` (default: all).
- `--json` — emit the snippets as structured JSON.
- See [MCP host setup](../practices/connecting-mcp-hosts.md) for deployed hosts and [connect an agent](../practices/connect-agent.md) for the local walkthrough.

## `weave schema:map [object] [--drift]`

Read-only report pairing every declared schema field with its PostgreSQL column: the expected type/constraints, and the live column state when the table exists. Requires a database connection; it never emits DDL and never writes.

- `weave schema:map` — every object as one report (a table per object).
- `weave schema:map <object>` — one table, with its indexes, foreign keys and RLS/owner state.
- `--drift` — show only drifting columns and tables (what `weave migrate` would change).
- `--json` — the structured report.

Per column it shows: `field`, the schema type (`relation → target.pk`, `enum[n]`), the column name, the expected PG type, constraints (`PK` / `NOT NULL` / `UNIQUE` / `DEFAULT …` / `FK → …`), and a `db` status — `ok`, `missing`, `type: <actual>`, `null: …`, or `extra (…)` for a live column not in the schema. Objects that are `details` children also list their engine-managed `parent_id` / `parent_type` / `parent_idx` columns.

## `weave schema:upgrade [--dry-run]`

Bring every `objects/<name>/schema.json` up to the current on-disk format version (see the [schema guide](schema.md#format-version)). Unversioned legacy files are stamped with the current `schemaVersion`; a file declaring a newer version aborts. `--dry-run` reports what would change without writing; real runs rewrite the files and auto-commit the metadata tree.

## `weave object:create <name>`

Scaffolds a new object: `objects/<name>/schema.json` (primary key + title field) plus `objects/<name>/server.js` — the sandboxed lifecycle-hook template. The metadata tree is auto-committed.

- Name must be `snake_case`.
- Requires the script subsystem ([script hooks](script-hooks.md)) to execute the hooks.

## `weave field:add <object>`

Adds a field to `objects/<name>/schema.json` and auto-commits:

- `--name <field>` `--type <type>` (required); `--required`, `--unique`, `--default <value>`, `--options a,b,c` (enum), `--target <object>` (relation/multiRelation).
- The whole updated schema is validated before writing (enum options, relation target, snake_case enforced).

## `weave module:add <name>` / `weave module:remove <name>`

Enables/disables a subsystem (currently `audit` or `script`) in `weavekit.config.ts` — the config stays the truth source — and auto-commits. Unknown subsystems (e.g. `workflow`) are rejected; if the config shape is unrecognized the command tells you to edit manually instead of corrupting the file.

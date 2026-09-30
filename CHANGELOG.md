# Changelog

All notable changes to `@weave-kit/engine`. Format follows [Keep a Changelog](https://keepachangelog.com/);
the project uses [Semantic Versioning](https://semver.org/).

## [0.6.0]

A breaking release. The data model, access control and workflow were reworked end to end. Read the
**Breaking** section before upgrading.

### Breaking

- **Record ids are the `record_key`.** A record's external id is now a single URL-safe string that
  encodes the (possibly composite) primary key, surfaced as the read-only `weave_id` field. REST
  `/{id}`, MCP `id` and batch `ids[]` all take this string — read it from a result or `describe_object`
  instead of composing the raw primary key.
- **Field types are bucketed** into PG-native value types and engine-shipped custom types. `person`
  was renamed to `user`; `SCALAR` was removed; `currency` accepts an optional ISO 4217 code (and an
  optional `precision`); `json` now maps to PostgreSQL `json` — use `jsonb` for the old behavior. Run
  `weave schema:upgrade`.
- **Row scopes add `department`** (`own | department | all`) plus a separate `manage` scope for writes,
  and a scope column's ids can be `internal` (engine ids) or `external` (customer ids).
- **Identity directory** — the engine now owns `weavekit_user` / `weavekit_department`; sync an external
  source with `weave sync:identity`, authenticate through a verifier, and manage users over the admin
  REST surface.
- **`multiRelation` uses a link table** (real FK per side, `ON DELETE CASCADE`) instead of a column;
  reads and filters are scoped to the targets the subject can read.
- **Workflow rewritten to a single-line node chain** (`workflow.json` format v2). v1 state-machine
  files are linearized on read. Instance/step/workitem state lives in engine tables
  (`weavekit_workflow_instances` / `_steps` / `_workitems`, plus locks/definitions/timers). New
  REST + MCP surface; `weave workflow:migrate` was **removed**; the side-table column
  `workflow_id` was renamed to `workflow_instance_id`; `weave migrate` drops and recreates the timer
  table.
- **Engine-owned system tables + runtime zero-DDL.** All DDL is emitted by `weave migrate`; the runtime
  never alters or drops customer columns (reads only).
- **Security hardening** — formula references respect RBAC, `details` children inherit (and can only
  narrow) their parent's permissions, DDL literals are escaped, and script SQL is gated by an AST pass.

### Added

- Record-metadata side tables with `weave_*` virtual fields (`weave_id`, `weave_status`,
  `weave_owner_id`, `weave_created_by`/`_modified_by`, `weave_created_time`/`_modified_time`,
  `weave_workflow_instance_id`) — request them in `fields`, and they work in `filter` / `sort`.
- Field types: native PG enums for static `enum`s, data-driven `enum` options, `seq_no`, `uuid`,
  `smallint`/`bigint`/`real`/`double`/`char`, numeric `precision`/`scale`, `json`/`jsonb`.
- Reverse-modeling: `weave introspect` handles composite primary keys and native enum/array columns;
  `weave schema:map` reports schema↔column drift.
- Workflow actions `submit` / `approve` / `reject` / `forward` / `withdraw` / `cancel` / `reactivate`,
  any-one / all approvals, node timeouts, an admin override, and definition write-back.
- `describe_object` exposes a field's resolved type `base`.

### Changed

- `weave migrate` registers content-addressed workflow definitions; instances pin the hash they started
  under, so editing `workflow.json` only affects new records.
- Live `record.transitioned` events carry `from` / `to` / `action`.

### Fixed

- Correct row-scope parameter offset on `update` / `delete` / `transition`.
- `record_key` encoding is single-sourced in SQL (contract-tested).

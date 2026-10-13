---
title: Migrations
description: "How schema.json maps onto a live database: create, validate-only, and additive alter."
---

# Migrations

`weave migrate` is the **only** thing that emits DDL. It's safe by construction: it will create
tables, but it never alters or drops your columns behind your back.

For each object it checks whether a table with that name already exists:

- **No table** → it creates one from the schema.
- **Table exists** → it only validates that every declared field is a real column, and emits **zero**
  DDL. A declared field with no matching column aborts with `object.field.columnMissing`.
- **`"alter": true`** (top-level in `schema.json`) → the object opts into **additive-only** DDL: ADD
  COLUMN, ADD CONSTRAINT, ADD FK, CREATE INDEX. Column types are never altered and columns are never
  dropped. A missing primary-key column still aborts.

Because DDL is additive-only, **removing a field never drops its column**. Delete the field from
`schema.json` and the database column and its data stay intact; the API stops exposing it, and writes
to it are rejected as an unknown field. To actually drop a column, run your own SQL
(`ALTER TABLE ... DROP COLUMN`). Re-adding a field with the same name but a different type doesn't
change the column type either — the diff only checks that a column with that name exists.

`weave dev` applies the same rules on hot-reload and commits schema changes to Git (see
[Git-versioned metadata](../04-git-versioned-metadata.md)). A change that would touch a read-only
existing table rejects the reload, keeps the running engine on the previous schema, and emits a
`schema.drift` event.

To see exactly how a schema maps to its live database — each field's expected column, type,
constraints, and any drift — run `weave schema:map` ([CLI reference](../../09-platform/02-cli.md)).

## Atomic deploys & schema revisions

`weave deploy apply` (and `weave migrate`) commit the DDL, the metadata cache and a global **schema
revision** in **one transaction** — an advisory lock serializes concurrent deploys, and any failure
rolls the whole thing back, so Git, PostgreSQL and the metadata cache can never drift apart. Each
apply records a revision in `weavekit_schema_revision`, keyed on a deterministic aggregate hash of
the schema files; re-applying an unchanged schema writes no new revision. `weave deploy plan`
previews the changes (read-only) with a **schema-impact analysis** (added columns/constraints/indexes,
data-compatibility risk, RBAC/scope impact, API-breaking flag), the live schema revision, and a
**config-drift** flag when the on-disk schema differs from the last applied revision.

Before a deploy — especially against a new or existing database — run `weave doctor`, a read-only
preflight (connection, PostgreSQL compatibility, schema/DB drift, engine system tables, RLS + sandbox)
that exits non-zero on any failure. `weave migrate --preflight` runs it first.

## Where engine tables live

Besides your objects, `weave migrate` provisions the engine's own tables: the `weavekit_*` **system
tables** (metadata cache, sequence counters, audit, approvals, workflow, evidence, counters), the
`weavekit_record__<object>` metadata **side tables** and the `weavekit_m2m__*` **link tables**.

By default they are created in the **object schema** (the connection's `current_schema()`), alongside
your tables. Set `EngineConfig.systemSchema` (e.g. `"weavekit"`) to keep them in a **dedicated
schema** instead — useful when a DBA reviews the customer schema and does not want engine plumbing in
it. When set:

- `weave migrate` creates the schema and qualifies every engine table into it; your object tables stay
  in the object schema.
- the runtime **appends** the schema to the connection's existing `search_path`, so its unqualified
  engine-table references resolve to the dedicated schema while your tables keep resolving through the
  object schema (a non-`public` object schema set on the connection — URL `options`, role default or
  `PGOPTIONS` — is preserved).

This applies to **new** databases. For an existing install, move the engine tables yourself
(`ALTER TABLE <name> SET SCHEMA <systemSchema>`) — the engine does not migrate their location.

## Related

- [Fields & types](02-fields-and-types.md)
- [RBAC](../../04-access/02-rbac.md)
- [Git-versioned metadata](../04-git-versioned-metadata.md) — where migrations come from
- [CLI reference](../../09-platform/02-cli.md) — `weave deploy plan|apply`, `weave doctor`

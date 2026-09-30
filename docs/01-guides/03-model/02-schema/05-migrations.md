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

## Related

- [Fields & types](02-fields-and-types.md)
- [RBAC](../../04-access/02-rbac.md)
- [Git-versioned metadata](../04-git-versioned-metadata.md) — where migrations come from

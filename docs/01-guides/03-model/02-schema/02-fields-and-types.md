---
title: Fields & types
description: "The field type table, common field attributes, and the enum / seq_no types."
---

# Fields & types

## Type table

| Type | TS / storage | Notes |
| --- | --- | --- |
| `string` | VARCHAR(255) | `minLength`/`maxLength`/`regex` |
| `text` | TEXT | long text |
| `char` | CHAR(n) | fixed length (`length`, default 1) |
| `smallint` | SMALLINT | `min`/`max` |
| `integer` | INTEGER | `min`/`max` |
| `bigint` | BIGINT | returned as a string (precision-safe) |
| `number` | NUMERIC | `min`/`max`/`precision`/`scale` |
| `real` | REAL | 4-byte float |
| `double` | DOUBLE PRECISION | 8-byte float |
| `currency` | NUMERIC(precision,scale) | money; optional ISO 4217 `currency` code sets the scale (USD=2, JPY=0, default 2) and optional `precision` sets the column precision (default 12, must exceed the scale) |
| `boolean` | BOOLEAN | |
| `date` | DATE | canonical `YYYY-MM-DD` |
| `time` | TIME | wall-clock time (no zone) |
| `timetz` | TIMETZ | time with offset |
| `timestamp` | TIMESTAMP | wall-clock timestamp (no zone) |
| `timestamptz` | TIMESTAMPTZ | absolute instant (UTC); `datetime` is a **deprecated alias** |
| `interval` | INTERVAL | ISO-8601 duration |
| `uuid` | UUID | |
| `json` | JSON | free-form JSON |
| `jsonb` | JSONB | binary JSON (indexable) |
| `enum` | native enum / VARCHAR | inline `options` or a [named reference](06-named-enums.md) → native PG enum; `{ from }` → VARCHAR; `multiple: true` → `<type>[]` |
| `seq_no` | VARCHAR | formatted sequence number |
| `relation` | target PK column + FK | weak reference (belongsTo) — see [Relations](03-relations.md) |
| `details` | child table | strong 1:N ownership — see [Relations](03-relations.md) |
| `multiRelation` | link table + FKs | multi-select reference — see [Relations](03-relations.md) |

Types come in two buckets: **PG-native value types** (`string`…`jsonb`, mapping near 1:1 to a
PostgreSQL type) and **engine-shipped custom types** (`enum`/`seq_no`/`relation`/`details`/
`multiRelation`, the semantic types `firstName`/`lastName`/`email`/`phone`/`image`/`currency`, and the
identity FK types `user`/`department`). `user`/`department` are relation-like and always point at the
engine identity objects (`weavekit_user`/`weavekit_department`) — no `target` is declared. Need a
business type the engine doesn't ship (`address`, …)? Register your own — see
[Custom field types](../../../04-reference/02-schema/02-custom-field-types.md).

## Common field attributes

- `primary: true` — one or more per object; must be a scalar, allowed-type field. Several `primary`
  fields form a **composite key** (declaration order is key order). Primary-key fields are immutable —
  updating one is rejected. The object name is the table name.
- `required: true` — NOT NULL; required on create.
- `unique: true` — unique constraint.
- `default` — typed per field; `date`/`timestamp`/`timestamptz` accept `"now"`.
- `labels` — display names keyed by locale, e.g. `{ "en": "Lead", "fr": "Piste" }`. Resolved as:
  requested locale → `en` → first entry → field name.
- `system: true` — user-declared reserved marker (the engine never recognizes fields by name).
- `ownership: true` / `department: true` — row-scope markers (string fields, at most one each). The
  `own`/`department` scopes filter on these. Mark a column's ids `internal` (engine ids, default) or
  `external` (customer ids) with `ownershipSource` / `departmentSource`. See
  [RBAC](../../04-access/02-rbac.md).

## `seq_no` — sequence numbers

```json
{ "name": "doc_no", "type": "seq_no", "format": "INV-{year}-{seq:5}", "cycle": "year" }
```

Placeholders: `{seq}` / `{seq:N}` (zero-padded), `{year}`, `{month}`, `{day}`. `cycle` is `none | year`.

## `enum`

An `enum` field's allowed values come from one of three sources: an inline `options` list, a
[declared named enum](06-named-enums.md) referenced by `enumType`, or a data-driven `{ from }` source.

### `enum.enumType` — a declared named enum

Reference a project-level enum declared in `enums/<name>.json` by `enumType` (and omit `options`).
Every field that shares an `enumType` shares one native PG enum type, so the values are declared once.
See [Named enums](06-named-enums.md).

```jsonc
{ "name": "status", "type": "enum", "enumType": "invoice_status", "default": "open" }
```

### `enum.multiple`

Fixed multi-select options stored as `TEXT[]` + GIN. `default` must be a subset of `options`.

### `enum.options` — static or data-driven

`options` is either an inline list or a `{ from }` source whose allowed values are the distinct values
of a **modeled object's column** (default: its primary key):

```jsonc
{ "name": "status", "type": "enum", "options": ["open", "won", "lost"] }                 // static
{ "name": "ccy",    "type": "enum", "options": { "from": { "object": "currency", "column": "code" } } }
{ "name": "tags",   "type": "enum", "multiple": true,
  "options": { "from": { "object": "tag", "column": "code" } } }                          // dynamic multi-select
```

- The source column may be any **scalar value** column (`string`/`text`/`integer`/`number`/…); values
  are compared as their **string form**, so the field value is always a string (an integer source `42`
  is addressed as `"42"`). Relation, array (a `multiple` field) and `json` sources are rejected at
  load (`graph.optionsFrom.*`).
- Writes are checked against the **existing** values in that column (`data.field.optionsFrom`).
- `default` is only allowed with the inline list (a data-driven set can't be validated up front).
- This is a **dynamic enum**, not a relation: no FK, no graph edge, no navigation. To reference a
  record (navigate/expand), use [`relation`](03-relations.md); for a non-string, non-entity set, use a
  [server hook](../../07-automation/02-script-hooks/02-authoring.md).

## Computed fields

A `formula` on a scalar field computes a read-only value on write:

```json
{ "name": "total", "type": "currency", "formula": "quantity * unit_price" }
```

See [Formulas](../03-formulas.md).

## Related

- [Named enums](06-named-enums.md) — share an enum across objects
- [Relations](03-relations.md) — `relation` / `details` / `multiRelation`
- [Validation](04-validation.md) — where non-enum rules go
- [Custom field types](../../../04-reference/02-schema/02-custom-field-types.md) — register your own

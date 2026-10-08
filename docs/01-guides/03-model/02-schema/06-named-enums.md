---
title: Named enums
description: "Declare a shared enum once in enums/ and reference it by enumType across objects."
---

# Named enums

A **named enum** is a project-level enum declaration shared by any number of objects. Instead of
repeating the same `options` list in every `schema.json`, you declare it once under `enums/` and
reference it from each field by `enumType`:

```
enums/invoice_status.json          →   the declaration (the source of truth)
objects/invoice/schema.json        →   { "name": "status", "type": "enum", "enumType": "invoice_status" }
objects/payment/schema.json        →   { "name": "state",  "type": "enum", "enumType": "invoice_status" }
```

Every field that shares an `enumType` shares **one native PostgreSQL enum type** — the values are
declared once, and adding a value is a single-file edit.

## Declaring an enum

One file per enum in `enums/`; the **file name must equal the enum `name`**, which must be a
snake_case identifier (it is also the PostgreSQL type name):

```jsonc
// enums/invoice_status.json
{
  "name": "invoice_status",
  "values": ["open", "paid", "void"],
  "labels": {
    "en": { "open": "Open", "paid": "Paid", "void": "Void" },
    "fr": { "open": "Ouverte", "paid": "Payée", "void": "Annulée" }
  }
}
```

- `values` — the allowed values (non-empty, unique). These are the stored values.
- `labels` — optional per-value display names, keyed by locale then value (`optionLabels` in
  `describe_object`). A label key must be one of `values`.

The declaration directory is `<schemaDir>/enums/`. It is optional: a project with no `enums/` behaves
exactly as before.

## Referencing an enum

A field references a declared enum by its `enumType` and omits `options`:

```json
{ "name": "status", "type": "enum", "enumType": "invoice_status", "default": "open" }
```

`multiple: true` produces `enumType[]` (still the one shared type). At load the reference is
resolved to the declared `values`, so `describe_object`, generated TypeScript, OpenAPI and the MCP
tool surface all see the same option set.

### The four enum field forms

| Form | `schema.json` | Storage |
| --- | --- | --- |
| Inline (static) | `{ "type": "enum", "options": ["open", "paid"] }` | native PG enum `<object>_<field>` |
| Inline + explicit name | `{ "type": "enum", "options": ["open", "paid"], "enumType": "custom_status" }` | native PG enum `custom_status` |
| **Named reference** | `{ "type": "enum", "enumType": "invoice_status" }` | native PG enum `invoice_status` (**shared**) |
| Data-driven | `{ "type": "enum", "options": { "from": { "object": "currency" } } }` | `VARCHAR` / `TEXT[]` |

The first three are **static** (a native PG enum); the fourth is a **dynamic** set read from another
object's column at write time — see [`enum.options`](02-fields-and-types.md#enumoptions--static-or-data-driven).
`enumType` has a dual role: **when it matches a declaration in `enums/` it is a named reference;
otherwise it is an explicit native type name.**

## Storage and migrations

- `weave migrate` runs `CREATE TYPE <enum>` once for a shared enum (not once per field), and
  `ALTER TYPE <enum> ADD VALUE IF NOT EXISTS` for new values on managed objects. DDL stays
  **additive-only**: values are never removed or renamed (PostgreSQL forbids it).
- Adding a value: edit `enums/<name>.json`, run `weave migrate`. Removing a value is not supported —
  to retire a value, keep it declared but stop using it.
- Adopted (read-only) tables are never altered; a named enum that mirrors an existing type is
  informational.

## Validation and CLI

Loading fails closed:

- `enum.invalid` — the declaration is malformed (name / values / labels).
- `enum.unknown` — a field `enumType` references a declaration that does not exist.
- `enum.options.mismatch` — inline `options` are given alongside a declared `enumType` but disagree
  with it (or a named enum is combined with a data-driven `from`).

Use `weave enum:check` in CI: it validates every declaration **and** every `objects/<name>/schema.json`
reference without a database. `weave enum:list` prints the declared enums; `weave field:add --enum <name>`
adds a named-reference field.

```sh
weave enum:list
weave enum:check
weave field:add invoice --name status --type enum --enum invoice_status
```

## Computed fields and multiple

- `default` must be a subset of the declared values.
- `multiple: true` is a multi-select (`enumType[]`, `TEXT[]`-equivalent storage); `multiple` cannot be
  `primary` or `unique` (same rule as inline enums).

## Related

- [Fields & types](02-fields-and-types.md) — the full type table and `enum.options`
- [Schema guide](01-overview.md) — format version and system fields
- [Modeling: shared enum vocabularies](../../../03-practices/05-modeling/02-named-enums.md) — a worked practice
- [CLI reference](../../09-platform/02-cli.md) — `weave enum:list` / `enum:check`

---
title: Validation
description: "What the engine checks at build time, and where custom rules belong."
---

# Validation

Validation comes from a few places. Reach for the cheapest one that fits; only fall back to a
[server hook](../../07-automation/02-script-hooks/02-authoring.md) when nothing declarative does.

| Need | Mechanism |
| --- | --- |
| primitive shape (string/number/boolean/date) + `min`/`max`/`length`/`regex`/`precision` | built-in field type (declarative) |
| required / unique | `required` / `unique` (column `UNIQUE`) / object `constraints` |
| custom local rule | a registered type's pure `validate` hook (any base) |
| value from a **data set** (codes, stringified) | `enum` + `options.from` |
| reference to an **entity** (navigate/join) | `relation` / `multiRelation` |
| cross-field / state / aggregate / bespoke DB rule | [server hook](../../07-automation/02-script-hooks/02-authoring.md) `validate` |

## Build-time rules

- Object and field names must be `snake_case`.
- Every object declares at least one `primary` scalar field (several = a composite key). The object
  name is the table name.
- `relation` / `details` / `multiRelation` targets must exist. The check runs across the whole set
  (`buildGraph`).
- Details children cannot declare the reserved `parent_*` columns.
- Formula fields cannot be `required` / `unique` / `primary`, and cannot have constraints.
- `read`/`manage: own` requires an `ownership` field; `department` requires a `department` or
  `ownership` field — see [RBAC](../../04-access/02-rbac.md).

## Computed fields

A `formula` on a scalar field computes a read-only value on write — see
[Formulas](../03-formulas.md).

## Related

- [Fields & types](02-fields-and-types.md)
- [Migrations](05-migrations.md)
- [Script subsystem](../../07-automation/02-script-hooks/01-overview.md) — the escape hatch for real logic

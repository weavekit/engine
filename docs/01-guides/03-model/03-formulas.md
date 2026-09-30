---
title: Formulas
description: "Computed, stored-on-write field values: operators, functions, aggregations and null semantics."
---

# Formulas

A `formula` computes a read-only field value on write, and the result is stored. Formulas work on six
scalar types: `string`, `text`, `number`, `currency`, `integer`, and `boolean`.

```json
{ "name": "total",  "type": "currency", "formula": "quantity * unit_price" },
{ "name": "label",  "type": "string",   "formula": "doc_no & \" / \" & title" },
{ "name": "is_big", "type": "boolean",  "formula": "total > 1000" }
```

## Operators

| Group | Operators |
| --- | --- |
| Arithmetic | `+` `-` `*` `/` and parentheses |
| Comparison | `=` `!=` `<` `<=` `>` `>=` |
| Logic | `AND` `OR` `NOT` |
| String concat | `&` |

## Functions

`IF(cond, a, b)`, `ROUND(x)`, `NOW()`, `CONCAT(...)`.

## Aggregations over detail rows

```json
{ "name": "lines_total", "type": "currency", "formula": "SUM(lines.amount)" }
```

`COUNT` and `SUM` work over a `details` child. `AVG` skips null values.

## Cross-object references

One level deep, referencing a scalar on a `relation` target:

```json
{ "name": "supplier_label", "type": "string", "formula": "supplier_id.name" }
```

Cross-object references obey RBAC: if the subject can't read the referenced target (object read
permission + row scope + field `exclude`), the reference resolves to `null` rather than leaking data —
see [RBAC](../04-access/02-rbac.md).

## Null semantics

| Expression | Result |
| --- | --- |
| arithmetic with a null operand | `null` |
| comparison with null | `false` |
| string concat with null | `''` |
| `SUM`/`AVG` over nulls | nulls skipped |

## Rules

- A formula field is read-only: no `required`, `unique`, `default`, `primary`, or constraints.
- References must resolve to scalar fields (no relations, and no aggregates of aggregates beyond one
  level).
- Cycles — including cross-object — are rejected at schema build time.
- When a dependency changes, the field is recomputed and persisted on the next write.

## Related

- [Fields & types](02-schema/02-fields-and-types.md) — where `formula` sits
- [Validation](02-schema/04-validation.md) — computed fields and the rule summary
- [Schema guide](02-schema/01-overview.md)

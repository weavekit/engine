# Formulas

A `formula` computes a read-only field value on write, and the result is stored. Formulas work on six
scalar types: `string`, `text`, `number`, `currency`, `integer`, and `boolean`.

```json
{ "name": "total",  "type": "currency", "formula": "quantity * unit_price" },
{ "name": "label",  "type": "string",   "formula": "doc_no & \" / \" & title" },
{ "name": "is_big", "type": "boolean",  "formula": "total > 1000" }
```

## Operators

- **Arithmetic**: `+ - * /` (and parentheses)
- **Comparison**: `= != < <= > >=`
- **Logic**: `AND` `OR` `NOT`
- **String concat**: `&`

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

## Null semantics

| Expression | Result |
| --- | --- |
| arithmetic with a null operand | `null` |
| comparison with null | `false` |
| string concat with null | `''` |
| `SUM`/`AVG` over nulls | nulls skipped |

## Rules

- A formula field is read-only: no `required`, `unique`, `default`, `primary`, or constraints.
- References must resolve to scalar fields (no relations, and no aggregates of aggregates beyond one level).
- Cycles — including cross-object — are rejected at schema build time.
- When a dependency changes, the field is recomputed and persisted on the next write.

---
title: Relations
description: "relation (belongsTo), details (owned 1:N) and multiRelation (multi-select), all declared on fields."
---

# Relations

There is **no `relations` array** — you declare relations on fields. Three field types cover the cases:

| Type | Meaning | Storage |
| --- | --- | --- |
| `relation` | weak reference (belongsTo) | FK column on this table |
| `details` | strong ownership (1:N) | child table with `parent_*` columns |
| `multiRelation` | multi-select reference | engine-owned link table |

## `relation` — weak reference (belongsTo)

```json
{ "name": "supplier_id", "type": "relation", "target": "supplier", "required": true }
```

A real FK column, typed like the target's primary key. `onDelete` defaults to `restrict` (`cascade` /
`set_null` are available). The reverse `hasMany` is derived automatically.

## `details` — strong ownership (1:N)

```json
// on the parent (order)
{ "name": "lines", "type": "details", "target": "order_line" }
```

Child rows live in their own table, with automatic `parent_id` / `parent_type` / `parent_idx` columns.
Deleting a parent cascades to its children; children are managed through their own object's CRUD.
`parent_id` stores the parent's `record_key` (a string), so a parent may use any primary-key type.

`details` children also **inherit their parent's permissions** (they can narrow, never broaden) and
their row scope — see [RBAC](../../04-access/02-rbac.md).

## `multiRelation` — multi-select reference

```json
{ "name": "tag_ids", "type": "multiRelation", "target": "tag" }
```

Stored in an engine-owned link table (`weavekit_m2m__<object>__<field>`) that mirrors both primary
keys and carries a **real foreign key per side** with `ON DELETE CASCADE` — deleting a record (owner
or target) removes the link rows. Reads return the ordered array of target ids.

Filters:

| Filter | Semantics |
| --- | --- |
| `contains` | superset |
| `in` | intersection |
| `eq` / `ne` | set equality / not equal |

`weave migrate` creates the link table; it's engine plumbing (like `weavekit_record__<object>`) and is
not visible to the restricted-SQL/script surface (RLS-denied as defense-in-depth).

When the request carries an authenticated subject, the returned ids are **scoped to the targets the
subject may read** — a `read: own`/`department` target only contributes visible ids, and its filters
are scoped the same way (a hidden id can neither be read nor probed). Element-level visibility, applied
on top of the target object's row scope.

## Related

- [Fields & types](02-fields-and-types.md)
- [RBAC](../../04-access/02-rbac.md) — permissions and row scopes, including `details` inheritance

---
title: Schema guide
description: "Objects and schema.json: the file format, record ids, system fields and object-level options."
---

# Schema guide

Everything starts with an **object** — a small `schema.json` that describes one table and how people
may use it. Objects live in `objects/<name>/`, and the folder name must match the object's `name`.

```json
// objects/lead/schema.json
{
  "name": "lead",
  "labels": { "en": "Lead" },
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "title", "type": "string", "required": true },
    { "name": "status", "type": "enum", "options": ["open", "won", "lost"], "default": "open" },
    { "name": "owner_id", "type": "string", "ownership": true }
  ],
  "permissions": {
    "sales": { "read": "own", "create": true, "update": ["title", "status"], "delete": true }
  }
}
```

`weave migrate` turns this into a PostgreSQL table plus REST/MCP surfaces. Your DDL never runs at
runtime — see [Migrations](05-migrations.md).

## In this section

- [Fields & types](02-fields-and-types.md) — the type table, common attributes, enums, `seq_no`
- [Relations](03-relations.md) — `relation` / `details` / `multiRelation`
- [Validation](04-validation.md) — what the engine checks and where custom rules go
- [Migrations](05-migrations.md) — how `schema.json` maps onto an existing table
- [Named enums](06-named-enums.md) — declare a shared enum once in `enums/`

## Format version

The on-disk format is versioned, and new files carry a top-level `schemaVersion`:

```json
{ "schemaVersion": 6, "name": "lead", "labels": { "en": "Lead" }, "fields": [ /* … */ ] }
```

Files written before versioning existed are treated as legacy version `0`. The engine migrates older
files in memory while loading, so they keep working; run `weave schema:upgrade` to stamp every file to
the current version (the change is auto-committed).

- **v2** replaced the scalar `label` with the per-locale `labels` map (writing `label` in a v2 file is
  rejected with `object.label.removed`).
- **v3** added object-level `constraints` (composite/scoped `UNIQUE`); additive, no rewrite.
- **v4** made `json` map to PostgreSQL `json` (it previously mapped to `jsonb`); `weave schema:upgrade`
  rewrites former `json` fields to `jsonb`, and `json` is now free to mean PG `json`.
- **v5** renamed the `person` field type to `user` and made the identity FK types (`user`,
  `department`) target the engine identity objects (`weavekit_user`/`weavekit_department`)
  implicitly — a declared `target` and the legacy `person.department` attr are dropped.
- **v6** added named enums: an enum may reference a declaration in `enums/<name>.json` by `enumType`
  (no inline `options`). Additive — inline enums keep working.

A file declaring a version **newer** than the engine supports is rejected with
`schema.version.unsupported` — fail closed rather than misread a future format.

## Record ids and system fields

A record's external id is its **`record_key`** — one URL-safe, decodable string that encodes the
ordered primary-key tuple (length-prefixed, so a value may contain any character):

```
encodeRecordKey(['O-1001'])       === '6:O-1001'
encodeRecordKey(['O-1001', '3'])  === '6:O-10011:3'
```

REST uses it in `/{id}`, MCP in `id`, batch operations in `ids[]`. The engine returns it as the
read-only virtual field **`weave_id`**. Don't build it by hand — read it from a result (or request it
in `fields`) and pass it back.

The engine also keeps system metadata **without touching your table** (zero DDL): status, ownership,
actor and timestamps live in an engine-owned side table keyed by the `record_key`. They're exposed as
**virtual fields** — never returned by default, requested explicitly, always read-only:

| Virtual field | Meaning |
| --- | --- |
| `weave_id` | the record's `record_key` (its external id) |
| `weave_status` | instance status: `draft` / `running` / `effective` / `canceled` (default `draft`) |
| `weave_owner_id` | owning subject (row-scope source) |
| `weave_created_by` / `weave_modified_by` | actor ids |
| `weave_created_time` / `weave_modified_time` | `timestamptz` |
| `weave_workflow_instance_id` | bound workflow instance, or null |

`describe_object` (and `GET /api/metadata?object=<name>`) lists them with `"virtual": true`. Pass them
in `fields` to read them; they also work in `filter` / `sort`.

## Object-level attributes

- `titleTemplate` — composite title, e.g. `"{doc_no} {customer_name}"`.
- `indexes` — extra btree/gin/gist indexes: `{ "type": "gin", "fields": ["tags"] }`.
- `constraints` — declarative **table-level UNIQUE** constraints, e.g.
  `{ "type": "unique", "fields": ["email", "tenant_id"] }`. Use one for **composite / scoped
  uniqueness** (a per-field `unique: true` covers a single column). Enforced by a real `UNIQUE(...)`,
  so it's race-free; a violation returns `409` (`data.unique`). On an existing table it's added via
  `ADD CONSTRAINT` under `alter: true`.
- `permissions` — see [RBAC](../../04-access/02-rbac.md).
- `labels` / `description` — display and introspection metadata.

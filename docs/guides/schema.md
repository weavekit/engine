# Schema guide

Objects are the unit of metadata. Each object lives in `objects/<name>/schema.json` — one directory per object, and the directory name must equal the object name.

```json
// objects/lead/schema.json
{
  "name": "lead",
  "label": "Lead",
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

## Format version

The on-disk format is versioned. New files carry a top-level `schemaVersion`:

```json
{ "schemaVersion": 1, "name": "lead", "fields": [ /* … */ ] }
```

Files written before versioning existed are treated as legacy version `0`.
The engine migrates them in memory when loading, so old files keep working; run
`weave schema:upgrade` to stamp every file to the current version (the change is
auto-committed). A file declaring a version **newer** than the engine supports is
rejected with `schema.version.unsupported` (fail-closed — never misread a future
format). Bumping the version is an engine change that ships with a migration.

## Field types

| Type | TS / storage | Notes |
| --- | --- | --- |
| `string` | VARCHAR(255) | `minLength`/`maxLength`/`regex` |
| `text` | TEXT | long text |
| `integer` | INTEGER | `min`/`max` |
| `number` | NUMERIC | `min`/`max`/`precision` |
| `currency` | NUMERIC(12,2) | money |
| `boolean` | BOOLEAN | |
| `datetime` | TIMESTAMPTZ | default `"now"` |
| `date` | DATE | |
| `json` | JSONB | free-form object |
| `enum` | VARCHAR + validation | `options`; `multiple: true` → TEXT[] |
| `seq_no` | VARCHAR | formatted sequence number |
| `relation` | target PK column + FK | weak reference (belongsTo) |
| `details` | child table | strong 1:N ownership |
| `multiRelation` | TEXT[] + GIN | multi-select reference |

## Common field attributes

- `primary: true` — exactly one per object; scalar types only. The object name is the table name.
- `required: true` — NOT NULL; required on create.
- `unique: true` — unique constraint.
- `default` — default value (typed per field; `datetime` supports `"now"`).
- `label` / `labels` — display names (per-locale via `labels`).
- `system: true` — user-declared reserved marker (engine never recognizes fields by name).
- `ownership: true` / `team: true` — RBAC row-scope markers (string fields, at most one each).

## Relations

There is **no `relations` array** — relations are declared on fields.

### `relation` — weak reference (belongsTo)

```json
{ "name": "supplier_id", "type": "relation", "target": "supplier", "required": true }
```

A real FK column typed like the target's primary key. `onDelete` defaults to `restrict` (`cascade` / `set_null` available). The reverse `hasMany` is derived automatically.

### `details` — strong ownership (1:N)

```json
// parent: order
{ "name": "lines", "type": "details", "target": "order_line" }
```

Child rows live in their own table with automatic `parent_id` / `parent_type` / `parent_idx` columns. Deleting a parent cascades to children; children are managed through their own object's CRUD. The parent's primary key must be a string.

### `multiRelation` — multi-select reference

```json
{ "name": "tag_ids", "type": "multiRelation", "target": "tag" }
```

Stored as `TEXT[]` + GIN index; application-level integrity.

### `seq_no` — sequence numbers

```json
{ "name": "doc_no", "type": "seq_no", "format": "INV-{year}-{seq:5}", "cycle": "year" }
```

Placeholders: `{seq}` / `{seq:N}` (zero-padded), `{year}`, `{month}`, `{day}`. `cycle: none | year`.

### `enum.multiple`

Fixed multi-select options stored as `TEXT[]` + GIN; `default` must be a subset of `options`.

## Computed fields

A `formula` on a scalar field computes a read-only value on write:

```json
{ "name": "total", "type": "currency", "formula": "quantity * unit_price" }
```

See [Formulas](formulas.md).

## Object-level attributes

- `titleTemplate` — composite title, e.g. `"{doc_no} {customer_name}"`.
- `indexes` — extra btree/gin/gist indexes: `{ "type": "gin", "fields": ["tags"] }`.
- `permissions` — see [RBAC](rbac.md).
- `labels` / `description` — display + introspection metadata.

## Validation rules (summary)

- Object and field names must be `snake_case`.
- Every object declares exactly one `primary` scalar field; the object name is the table name. `weave migrate` creates tables for objects with no live table, and only **validates** objects whose table already exists (every declared field must be a real column — `object.primary.columnMissing` / `object.field.columnMissing`). The engine never ALTERs an existing table unless the object opts in with `"alter": true` (top-level in `schema.json`), which emits **additive-only** DDL (ADD COLUMN / ADD CONSTRAINT / ADD FK / CREATE INDEX) for schema changes — column types are never altered and columns never dropped. `weave dev` applies the DDL for `alter: true` objects on hot-reload and git-commits the schema changes; a change on a read-only existing table rejects the reload and surfaces a `schema.drift` event.
  - **Removing a field never drops the column.** DDL is additive-only, so deleting a field from `schema.json` leaves the database column and its data intact; the API simply stops exposing it (writes to it are rejected as an unknown field). To physically drop a column use your own SQL (`ALTER TABLE ... DROP COLUMN`). Likewise, re-adding a field with the same name but a different type will not upgrade the column type — the diff only checks that a column with that name exists.
- `relation`/`details`/`multiRelation` targets must exist (checked across the whole set by `buildGraph`).
- Details children cannot declare the reserved `parent_*` columns.
- Formula fields cannot be `required`/`unique`/`primary` and cannot have constraints.
- `read: own` requires an `ownership` field; `read: team` requires a `team` field.

To see how a schema maps to its live database — each field's expected column, type, constraints and any drift — run `weave schema:map` ([CLI reference](cli.md)).

# Schema guide

Everything starts with an **object** — a small `schema.json` file that describes one table and how
people may use it. Objects live in `objects/<name>/`, and the folder name must match the object's
`name`.

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

The on-disk format is versioned, and new files carry a top-level `schemaVersion`:

```json
{ "schemaVersion": 1, "name": "lead", "fields": [ /* … */ ] }
```

Files written before versioning existed are treated as legacy version `0`. The engine migrates them
in memory while loading, so old files keep working. Run `weave schema:upgrade` to stamp every file to
the current version (the change is auto-committed).

If a file declares a version **newer** than the engine supports, the engine rejects it with
`schema.version.unsupported`. It fails closed rather than risk misreading a future format. Bumping
the version is an engine change that ships together with a migration.

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

- `primary: true` — exactly one per object, scalar types only. The object name is the table name.
- `required: true` — NOT NULL; required on create.
- `unique: true` — unique constraint.
- `default` — default value (typed per field; `datetime` supports `"now"`).
- `label` / `labels` — display names (per-locale via `labels`).
- `system: true` — user-declared reserved marker (the engine never recognizes fields by name).
- `ownership: true` / `team: true` — RBAC row-scope markers (string fields, at most one each).

## Relations

There is **no `relations` array**. You declare relations on fields.

### `relation` — weak reference (belongsTo)

```json
{ "name": "supplier_id", "type": "relation", "target": "supplier", "required": true }
```

A real FK column, typed like the target's primary key. `onDelete` defaults to `restrict`
(`cascade` / `set_null` are available). The reverse `hasMany` is derived automatically.

### `details` — strong ownership (1:N)

```json
// parent: order
{ "name": "lines", "type": "details", "target": "order_line" }
```

Child rows live in their own table with automatic `parent_id` / `parent_type` / `parent_idx` columns.
Deleting a parent cascades to its children, and children are managed through their own object's CRUD.
The parent's primary key must be a string.

### `multiRelation` — multi-select reference

```json
{ "name": "tag_ids", "type": "multiRelation", "target": "tag" }
```

Stored as `TEXT[]` + a GIN index. Integrity is your application's concern.

### `seq_no` — sequence numbers

```json
{ "name": "doc_no", "type": "seq_no", "format": "INV-{year}-{seq:5}", "cycle": "year" }
```

Placeholders: `{seq}` / `{seq:N}` (zero-padded), `{year}`, `{month}`, `{day}`. `cycle` is
`none | year`.

### `enum.multiple`

Fixed multi-select options stored as `TEXT[]` + GIN. `default` must be a subset of `options`.

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
- `labels` / `description` — display and introspection metadata.

## Validation rules (summary)

- Object and field names must be `snake_case`.
- Every object declares exactly one `primary` scalar field. The object name is the table name.
- `relation` / `details` / `multiRelation` targets must exist. The check runs across the whole set (`buildGraph`).
- Details children cannot declare the reserved `parent_*` columns.
- Formula fields cannot be `required` / `unique` / `primary`, and cannot have constraints.
- `read: own` requires an `ownership` field; `read: team` requires a `team` field.

## How migration handles existing tables

`weave migrate` is the only thing that emits DDL. For each object it checks whether a table with that
name already exists:

- **No table** → it creates one from the schema.
- **Table exists** → it only validates that every declared field is a real column, and emits **zero**
  DDL. A declared field with no matching column aborts with `object.field.columnMissing`.
- **`"alter": true`** (top-level in `schema.json`) → the object opts into **additive-only** DDL: ADD
  COLUMN, ADD CONSTRAINT, ADD FK, CREATE INDEX. Column types are never altered and columns are never
  dropped. A missing primary-key column still aborts.

Because DDL is additive-only, **removing a field never drops the column**. Deleting a field from
`schema.json` leaves the database column and its data intact; the API stops exposing it, and writes to
it are rejected as an unknown field. To drop a column, run your own SQL
(`ALTER TABLE ... DROP COLUMN`). Re-adding a field with the same name but a different type does not
change the column type either — the diff only checks that a column with that name exists.

`weave dev` applies the same rules on hot-reload and commits schema changes to Git (see
[Git-versioned metadata](git-versioned-metadata.md)). A change that would touch a read-only existing
table rejects the reload, keeps the running engine on the previous schema, and emits a `schema.drift`
event.

To see exactly how a schema maps to its live database — each field's expected column, type,
constraints, and any drift — run `weave schema:map` ([CLI reference](cli.md)).

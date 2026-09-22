# Custom field types

WeaveKit ships a fixed set of **built-in** field types (see [Schema](../guides/schema.md)). When a
project needs business semantics the built-ins don't cover (`money`, `address`, `rating`, …), you can
register **custom field types** without patching the engine.

A registered type is a **thin, declarative layer over a built-in primitive**: you declare a `base`,
and the engine inherits storage, TypeScript generation, OpenAPI schemas and describe behaviour from
it. Registered types are project-local and committed to Git, so every environment resolves the same
set — schemas stay reproducible.

## Naming: the namespace rule

- **Bare names are reserved for the engine** (`string`, `currency`, `seq_no`, `person`, …). A
  registration cannot use one.
- **Registered types must be namespaced**: `<namespace>_<name>` (lowercase snake_case). This keeps
  user/plugin types from ever colliding with built-ins — now or in a future release.
- `x_` is the conventional namespace for one-off project types; plugins use their own (`acme_money`).

## Declaring a registration

A registration module lives under `field-types/` and default-exports a registration (or an array):

```ts
// field-types/acme.ts
import type { FieldTypeRegistration } from '@weave-kit/engine';

export default [
  { namespace: 'acme', name: 'money', base: 'number' },
  { namespace: 'acme', name: 'email', base: 'string', openApiFormat: 'email' },
  { namespace: 'acme', name: 'account', base: 'relation', relationLike: true },
] satisfies FieldTypeRegistration[];
```

| Field | Meaning |
| --- | --- |
| `namespace` | prefix auto-applied to `name` (`acme` + `money` → `acme_money`) |
| `name` | the type name (without the namespace, or already prefixed) |
| `base` | **required**; the value primitive to inherit from |
| `scalar` | can be a primary key (defaults from `base`) |
| `relationLike` | carries a `target` (defaults from `base`) |
| `ui` | frontend hint, e.g. `{ visual: 'image' }` (never a widget — the engine is headless) |
| `openApiFormat` | OpenAPI `format` keyword for string-based types (`email`, `uri`, …) |
| `attrs` | typed extra attributes a field of this type accepts: `{ <name>: { type, values?, required?, default? } }` (validated, fail-closed) |
| `storage` | custom column mapping: `{ pgType: (field) => string }` (output safety-checked; non-relation bases only) |
| `validate` | pure, synchronous write-time check `(field, value) => string \| undefined` (non-relation bases only) |
| `references` | the value must exist in a modeled object's column: `{ object, column? }` (non-relation bases only) |
| `reverse` | optional introspect hint: `{ pgType: 'NUMERIC(12,2)' }` maps a matching live column back to this type |

**Allowed bases**: `string`, `text`, `integer`, `number`, `currency`, `boolean`, `datetime`, `date`,
`json`, `relation`. The structural types (`enum`, `details`, `multiRelation`, `seq_no`) and the
semantic types (`image`, `person`, `department`) are **not** valid bases.

## Enabling registrations

Point the engine at the directory (and/or inline entries) in `weavekit.config.ts`:

```ts
export default {
  schemaDir: '.',
  fieldTypes: { dir: 'field-types' },   // relative to schemaDir
  features: {
    // the whitelist also gates registered types by name
    fieldTypes: ['string', 'integer', 'number', 'currency', 'acme_money'],
  },
};
```

The effective registry is compiled once at load: **built-ins + registrations**. It is passed through
validation and every consumer (explicit injection — there is no mutable global). A schema using a
type that is not registered fails closed with `field.type.unknown`; one outside
`features.fieldTypes` fails with `field.type.disabled`.

## Using a registered type

Once registered, a type is just a type:

```json
// objects/invoice/schema.json
{
  "schemaVersion": 2,
  "name": "invoice",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "amount", "type": "acme_money", "required": true },
    { "name": "billing_email", "type": "acme_email" }
  ]
}
```

`acme_money` stores as `NUMERIC`, appears as `number` in generated TypeScript, and as
`{ "type": "number" }` in OpenAPI — all inherited from `base: "number"`.

## Beyond the base: attrs, storage & validation

A registered type can go beyond inheriting its base:

- **`attrs`** — declare typed extra attributes. The engine validates each field value at schema load
  (`field.attr.type` / `field.attr.enum` / `field.attr.required`) and preserves the values on the
  field. The base primitive's own attributes (`min`/`max`/`minLength`/`maxLength`/`regex`/`precision`)
  are inherited automatically and enforced at write time.
- **`storage.pgType`** — map the field to a custom PostgreSQL column type. The function is pure; its
  output is checked against a safe grammar (a known type with optional size and `[]`) before it reaches
  DDL, and an unsafe value fails closed (`fieldtype.storage.invalid`). Relation-like types cannot
  override storage (the column type follows the FK target).
- **`validate`** — a pure, synchronous write-time check. Return a human-readable detail to reject the
  value (`data.field.custom`, whose detail string is passed through verbatim), or `undefined` to
  allow. No I/O: cross-record or database-backed rules belong to [server hooks](../guides/script-hooks.md)
  or `references`.
- **`references`** — the value must exist in a column of a **modeled object** (`{ object, column? }`;
  the column defaults to the target's primary key). Checked inside the write transaction on create
  and update (`data.field.references`); a missing object/column fails validation at load
  (`graph.references.target.missing` / `graph.references.column.missing`).

```ts
// field-types/acme.ts
import type { FieldTypeRegistration } from '@weave-kit/engine';

export default [
  {
    namespace: 'acme',
    name: 'money',
    base: 'number',
    attrs: { currency: { type: 'string', required: true }, scale: { type: 'integer', default: 2 } },
    storage: { pgType: (f) => `NUMERIC(12,${(f as { scale?: number }).scale ?? 2})` },
  },
  {
    namespace: 'acme',
    name: 'currency',
    base: 'string',
    references: { object: 'currency', column: 'code' },
    validate: (_f, v) => (typeof v === 'string' && v.length === 3 ? undefined : 'must be a 3-letter code'),
  },
] satisfies FieldTypeRegistration[];
```

> Custom `pgType` affects **new tables** and the drift report (`weave schema:map`). Migrations are
> **additive-only** — a changed mapping is reported as `type` drift, never auto-`ALTER`ed.

## Production builds

`weave dev` loads `field-types/*.ts` directly. For production, `weave build` compiles them to
`dist/field-types/*.js`; point the engine at the compiled output:

```ts
export default { fieldTypes: { dir: 'dist/field-types' } };
```

## Existing databases (brownfield)

Registered types are a **forward authoring** concept; the engine does not reverse-infer them unless
you give a registration a `reverse` hint.

- **With a `reverse` hint** — `{ pgType: 'NUMERIC(12,2)' }` — `weave introspect` maps a live column
  whose PostgreSQL type matches back to the registered type, so the generated `schema.json` already
  carries it. If several registrations match one column, the primitive is kept and a warning is
  emitted (no ambiguity failure). Relation columns are never reverse-mapped.
- **Without a hint** — `weave introspect` reverse-models live tables into **built-in** types only.
  Hand-edit the generated `schema.json` to switch a field to a registered type; generated files are
  kept unless you pass `--force`.
- The existing column must be compatible with the registration's `base` storage (e.g. `NUMERIC` for
  `base: "number"`). `weave migrate` on an existing table only checks that the column **exists** and
  never alters its type; `weave schema:map` reports a `type` drift if the column doesn't match.

## Limits

- `validate` must be **pure and synchronous** (no I/O). Database-backed or cross-record rules belong
  to [server hooks](../guides/script-hooks.md), `references` (membership), or custom tools.
- `storage` maps the **column type** only; there is no custom SQL `DEFAULT` (the base `default` is
  used) and no custom type-change migration (additive-only).
- Reverse inference (`introspect`) requires an explicit `reverse` hint; without one, registered types
  are forward-authoring only.

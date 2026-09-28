# RBAC — roles, permissions, and row scopes

You write permissions once, and every surface obeys them. Enforcement lives in the data-access layer,
so REST, MCP, and the protocol adapters you enable all get the same rules for free — there is no
per-interface permission code to maintain.

## Permission model (default-denied when a map is present)

```json
{
  "permissions": {
    "admin":     { "read": "all",        "create": true, "update": true, "delete": true },
    "sales":     { "read": "own",        "create": true, "update": ["title", "status"], "delete": true },
    "sales_mgr": { "read": "department", "manage": "department", "update": ["status"], "delete": false },
    "finance":   { "read": "all",        "fields": { "exclude": ["commission"] } },
    "auditor":   { "read": "all",        "manage": "own" }
  }
}
```

Per role:

- `read`: `all` | `own` | `department` — the row scope for reads
- `manage`: `all` | `own` | `department` — the row scope for **writes** (update/delete/transition);
  defaults to `read` when omitted
- `create`: boolean
- `update`: `true` (all fields) or an array of field names the role may update (empty = none); omitted or false = none
- `delete`: boolean
- `fields.exclude`: columns stripped from every response — the data never leaves the database

**Semantics (model B):**

- **No `permissions` map** → open mode: full CRUD for any authenticated subject.
- **Map present** → roles not listed are denied. A listed role is denied for any operation it doesn't explicitly grant.
- **Multiple roles merge** → `read`/`manage` take the most permissive scope; `update` and `exclude` are unioned.

## Row scopes

`own` and `department` filter rows by a marker column you declare:

```json
{ "fields": [
  { "name": "owner_id", "type": "string", "ownership": true },
  { "name": "department_id", "type": "string", "department": true }
] }
```

- **`own`** — rows where the `ownership` column identifies the subject (`= subject.id`).
- **`department`** — rows whose department is the subject's department **or a descendant**. The
  department is taken from the `department` column if declared; otherwise it is derived from the
  record's owner (`owner → weavekit_user.department_id`). The subtree recurses over
  `weavekit_department`. A subject without `departmentId` gets a 403 (`rbac.departmentId.missing`).
- **`all`** — no row filter.

A role that uses `own`/`department` **must** declare a matching field; validation rejects the schema
otherwise (`permission.own.ownershipField` / `permission.department.missingField`).

### Where a scope column's ids come from

A marker column holds ids in one of two spaces (`ownershipSource` / `departmentSource`):

```json
{ "name": "sales_rep_id", "type": "string", "ownership": true, "ownershipSource": "external" }
```

- `internal` (default) — the engine's own ids (`weavekit_user` / `weavekit_department` uuids).
- `external` — the customer's ids (e.g. from the synced identity source); the engine translates them
  through `weavekit_user.external_id` / `weavekit_department.external_id`.

This lets you filter an untouched customer table by its own ownership column without rewriting it.

## Authenticated subject

Authentication maps a credential to a subject `{ id, roles, departmentId? }`:

```ts
{
  auth: {
    source: {
      'sk-rep': { id: 'u100', roles: ['sales'], departmentId: 'd-east' },
      'sk-mgr': { id: 'u300', roles: ['sales_mgr'] },
    },
  },
}
```

Or authenticate through the engine identity directory (see [Identity](identity.md)): a verifier turns
a credential into an identity, the directory resolves it to the internal subject (roles + department).

## HTTP behavior

| Condition | Status | Code |
| --- | --- | --- |
| Missing / invalid API key | 401 | `auth.missingKey` / `auth.invalidKey` |
| Role denied an operation | 403 | `rbac.denied.read/create/update/delete` |
| Field not updatable | 403 | `rbac.denied.field` |
| `department` scope without a department | 403 | `rbac.departmentId.missing` |
| Role uses a scope with no matching field | 403 | `rbac.scope.columnMissing` |
| Row outside scope (read/update/delete) | 404 | `data.recordNotFound` — **does not leak existence** |

## Example

`sales` with `read: own`, `manage: own`, `exclude: ["secret"]`, department `d-east`:

- `find()` returns only their own rows, without the `secret` column.
- `findOne()` / `update()` on another user's row → 404.
- `sales_mgr` with `read: department` sees the whole `d-east` subtree; `manage` scopes writes the same way.

## Script SQL (RLS)

Inside `*.server.js`, `this.db.query` runs under a restricted PG role with row-level security derived
from the same matrix. Its `own`/`department` predicates are **flat equality on internal ids** (they do
not expand the department subtree or translate external ids) — use `this.db.objects` for those. Flat
equality is strictly narrower, so RLS never over-exposes.

## Details children inherit their parent

A `details` child is an owned part of its parent record, so its permissions are **derived from the
parent object** rather than defined on the child:

- A child with **no** `permissions` is exactly its parent's — read/manage scope and create/update/
  delete are taken from the parent.
- A child **may narrow** (declare stricter permissions) but never broaden: the two are intersected
  (scope = the narrower one, operations = AND, hidden fields = union). A child declaring broader
  permissions than its parent is rejected at load (`permission.detailsChild.broader`).
- A child belongs to **exactly one** parent — a shared child must use `relation`/`multiRelation`, not
  `details` (`graph.details.multiParent`).
- Row scopes are inherited through the parent link: a child row is visible iff its `parent_id` points
  at a parent row the subject can read.

Cross-object **formula** references (`relation.target_field`, `SUM(lines.qty)`) are resolved under the
same rules: if the subject cannot read the referenced target (object read permission + row scope +
field `exclude`), the reference resolves to `null` rather than leaking data.

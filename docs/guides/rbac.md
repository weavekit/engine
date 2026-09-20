# RBAC — roles, permissions, and row scopes

You write permissions once, and every surface obeys them. Enforcement lives in the data-access layer,
so REST, MCP, and the protocol adapters you enable all get the same rules for free — there is no
per-interface permission code to maintain.

## Permission model (default-denied when a map is present)

```json
{
  "permissions": {
    "admin":      { "read": "all",  "create": true, "update": true, "delete": true },
    "sales":  { "read": "own",  "create": true, "update": ["title", "status"], "delete": true },
    "sales_mgr":  { "read": "team", "update": ["status"], "delete": false },
    "finance":    { "read": "all",  "fields": { "exclude": ["commission"] } }
  }
}
```

Per role:

- `read`: `all` | `own` | `team`
- `create`: boolean
- `update`: `true` (all fields) or an array of field names the role may update (empty = none); omitted or false = none
- `delete`: boolean
- `fields.exclude`: columns stripped from every response — the data never leaves the database

**Semantics (model B):**

- **No `permissions` map** → open mode: full CRUD for any authenticated subject.
- **Map present** → roles not listed are denied. A listed role is denied for any operation it doesn't explicitly grant.
- **Multiple roles merge** → `read` takes the most permissive scope; `update` and `exclude` are unioned.

## Row scopes

`own` and `team` reads filter rows by an ownership / team marker column:

```json
{ "name": "owner_id", "type": "string", "ownership": true },
{ "name": "team_id", "type": "string", "team": true }
```

- `read: own` requires an `ownership` field. Rows are filtered to `ownership_field = subject.id`.
- `read: team` requires a `team` field. Rows are filtered to `team_field = subject.teamId`; a subject without `teamId` gets a 403.
- `all` applies no row filter.

The engine **never auto-adds** these columns and never recognizes them by name — you declare them.

## Authenticated subject

Authentication is API-key based and maps a key to a subject:

```ts
{
  auth: {
    source: {
      'sk-rep': { id: 'u100', roles: ['sales'] },
      'sk-mgr': { id: 'u300', roles: ['sales_mgr'], teamId: 't1' },
    },
  },
}
```

A subject is `{ id, roles, teamId? }`.

## HTTP behavior

| Condition | Status | Code |
| --- | --- | --- |
| Missing / invalid API key | 401 | `auth.missingKey` / `auth.invalidKey` |
| Role denied an operation | 403 | `rbac.denied.read/create/update/delete` |
| Field not updatable | 403 | `rbac.denied.field` |
| `read: team` without `teamId` | 403 | `rbac.teamId.missing` |
| Row outside scope (update/delete) | 404 | `data.recordNotFound` — **does not leak existence** |

Update and delete inherit the read row scope. Acting on a row you cannot read behaves exactly like the
row not existing.

## Example

`sales` with `read: own` and `exclude: ["secret"]`:

- `find()` returns only their own rows, without the `secret` column.
- `findOne()` on another user's row → 404.
- `update()` on another user's row → 404.
- `update()` attempting to set a field outside `["title","status"]` → 403.

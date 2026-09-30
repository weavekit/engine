---
title: "Identity — the engine directory"
description: "WeaveKit runs RBAC against its own identity directory (weavekit_user / weavekit_department) — the single id space that row scopes, audit actors, and workflow a…"
---
# Identity — the engine directory

WeaveKit runs RBAC against its **own identity directory** (`weavekit_user` /
`weavekit_department`) — the single id space that row scopes, audit actors, and workflow
assignees all use. An existing customer directory is an **import source**: you sync it into the
engine *before* the engine serves scoped access. The engine only ever **reads** the source tables.

## Why sync first

If the engine scoped rows against customer ids while RBAC also needed internal ids, every row
filter, audit entry, and workflow node would have to translate across two id spaces. Syncing once
up front keeps a single internal id everywhere.

```ts
// weavekit.config.ts
export default {
  identity: {
    source: {
      name: 'crm',
      users:       { table: 'sales_user', id: 'id', name: 'name', email: 'email',
                     roles: 'role', department: 'dept_id', director: 'manager_id', enabled: 'active' },
      departments: { table: 'dept', id: 'id', name: 'name', parent: 'parent_id', manager: 'lead_id', enabled: 'active' },
    },
    sync: { onStart: false, deactivateMissing: true },
    required: true,
  },
} satisfies EngineConfig;
```

Then:

```bash
weave sync:identity          # read-only against the customer tables
weave sync:identity --dry-run
```

The sync is idempotent (upsert on `(external_source, external_id)`), links departments/users in two
passes (a child may reference a parent listed later), detects department parent cycles, keeps a
cursor for incremental sources, and **soft-disables** (never deletes) rows missing from the snapshot.

## Sources

`identity.source` is either a declarative `pg` descriptor (above) or a function-backed
`IdentitySource`:

```ts
import { createFunctionIdentitySource } from '@weave-kit/engine';

const source = createFunctionIdentitySource({
  name: 'hr',
  pull: async (cursor) => {
    const rows = await hrApi.usersSince(cursor);
    return { users: rows.users, departments: rows.departments, cursor: rows.cursor };
  },
});
```

Enterprise integrations (SCIM, LDAP, HRIS) implement the same `IdentitySource` contract and are
injected the same way — the engine core stays free of protocol dependencies.

## Authentication

Either keep the static key map / custom resolver:

```ts
{ auth: { source: { 'sk-rep': { id: 'u100', roles: ['sales'], departmentId: 'd-east' } } } }
```

…or let a verifier authenticate and the directory resolve:

```ts
{
  identity: {
    verifier: { verify: (header) => verifyJwt(header) }, // → { ref, claims } | null
    required: true,
  },
}
```

`verifier → directory → subject`. A verified credential with **no synced local user** is rejected
with `identity.notSynced` (403) — run `weave sync:identity` first. `identity.required` also gates a
custom `auth.source` on the directory.

## Managing identities

Greenfield projects (no external source) manage users directly:

```bash
weave identity:list
weave identity:create "Alice" --email alice@x --roles admin,sales
weave identity:disable <id>
weave identity:enable  <id>
```

Or the admin REST surface (gated by `adapters.rest.adminRoles`):

| Route | Purpose |
| --- | --- |
| `GET /api/identity/users` | list local users |
| `POST /api/identity/users` | create a user |
| `PATCH /api/identity/users/:id` | enable/disable |

## Extending (enterprise)

The engine ships the seam and the `pg`/`function` sources; `@weave-kit/enterprise` adds OIDC/JWT/SAML
verifiers, a SCIM 2.0 server, LDAP and HRIS connectors against the same `IdentitySource` /
`AuthVerifier` contracts. See [RBAC](02-rbac.md) for how the resulting subject scopes rows.

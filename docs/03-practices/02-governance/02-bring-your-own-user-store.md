---
description: "Point the engine at the customer's own user store — sync it into the engine identity directory (recommended) or resolve identities with a function."
---

# Plugging in the customer's own user store

Real CRMs have user tables: people join, leave, change roles and departments. There are two ways to
keep the engine's identity current without a hardcoded `auth.source` / `mcp.identities` list:

- **Sync into the engine directory (recommended)** — `weave sync:identity` reads your user table
  (read-only) and provisions the engine's own `weavekit_user` / `weavekit_department`. RBAC,
  audit and workflow then run on one internal id space.
- **Resolver functions (alternative)** — `auth.source` and `mcp.identities` accept functions that
  query your store on each session. No local copy, but row scopes still compare against whatever ids
  your resolvers return.

Both are described below. Reach for the sync when you want `own`/`department` scopes, audit actors
and workflow assignees to share one id space; reach for a resolver when identity genuinely cannot be
imported.

## Background

[Integrating an existing CRM](../01-agent/02-existing-crm-to-mcp.md) keeps identity in config (`alice → sales`) —
perfect for a handful of people. For a real user table, a parallel hardcoded list becomes a second
source of truth that drifts, and role changes mean editing config and restarting the engine.

## Path A — sync the engine directory (recommended)

The engine owns identity (`weavekit_user` / `weavekit_department`); your table is an **import
source**. See [Identity](../../01-guides/04-access/03-identity.md) for the full model.

### 1. The customer's tables

```sql
CREATE TABLE crm_dept (
  id        VARCHAR(36) PRIMARY KEY,
  name      VARCHAR(255),
  parent_id VARCHAR(36)
);

CREATE TABLE crm_users (
  id      VARCHAR(36) PRIMARY KEY,   -- the on-behalf-of ref
  name    VARCHAR(255),
  role    VARCHAR(50),               -- maps to a key in your schema permissions
  dept_id VARCHAR(36)
);
INSERT INTO crm_dept  (id, name, parent_id) VALUES ('d-east', 'East', NULL);
INSERT INTO crm_users (id, name, role, dept_id) VALUES
  ('alice', 'Alice Johnson', 'sales',   'd-east'),
  ('alex',  'Alex Carter',   'manager', 'd-east');
```

### 2. Declare the source + an external ownership column

`objects/lead/schema.json` — the owner column holds your `crm_users.id` values, so mark it
`ownershipSource: "external"`:

```jsonc
{
  "name": "lead",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "name", "type": "string" },
    { "name": "owner_ref", "type": "string", "ownership": true, "ownershipSource": "external" },
    { "name": "secret", "type": "string" }
  ],
  "permissions": {
    "sales":   { "read": "own", "manage": "own", "create": true, "update": ["name"], "delete": false, "fields": { "exclude": ["secret"] } },
    "manager": { "read": "department", "create": true, "update": true, "delete": true }
  }
}
```

### 3. Configure the source and sync

```ts
import type { EngineConfig } from '@weave-kit/engine';

export default {
  schemaDir: '.',
  auth: { source: { 'sk-agent': { id: 'agent-1', roles: ['agent'] } } },
  identity: {
    source: {
      name: 'crm',
      users:       { table: 'crm_users', id: 'id', name: 'name', roles: 'role', department: 'dept_id' },
      departments: { table: 'crm_dept',  id: 'id', name: 'name', parent: 'parent_id' },
    },
    required: true,          // reject an on-behalf-of ref with no synced local user
  },
} satisfies EngineConfig;
```

```sh
weave migrate            # lead table + the engine identity tables
weave sync:identity      # read-only against crm_users/crm_dept → weavekit_user/department
weave dev
```

The on-behalf-of ref (`alice`) now resolves through the engine directory (no `mcp.identities`
needed); `owner_ref = 'alice'` is translated to the internal user, and `manager` sees the `d-east`
subtree. Run `weave sync:identity` again whenever the CRM changes.

## Path B — resolver functions (alternative)

If the store cannot be imported, both `auth.source` and `mcp.identities` accept functions:

```ts
const pool = createPool(process.env.DATABASE_URL!);

export default {
  schemaDir: '.',
  auth: {
    source: (header) => {
      const m = /^Bearer\s+jwt-(\w+)$/.exec(header ?? '');
      return m === null ? null : { id: `agent-${m[1]}`, roles: ['agent'] };
    },
  },
  adapters: {
    mcp: {
      identities: async (ref) => {
        const res = await pool.query(`SELECT id, role, dept_id FROM crm_users WHERE id = $1`, [ref]);
        const row = res.rows[0];
        if (row === undefined) return null;
        return { id: row.id, roles: [row.role], ...(row.dept_id ? { departmentId: row.dept_id } : {}) };
      },
    },
  },
} satisfies EngineConfig;
```

Both fields are union types — `Record<string, IdentitySubject> | AuthResolver` and
`Record<string, IdentitySubject> | IdentityResolver`; a function wins. Note the returned ids are the
customer's, so a scope column must match that source (`ownershipSource: "external"` if it holds
`crm_users.id`).

## Which to use

| | Path A — sync | Path B — resolver |
| --- | --- | --- |
| Directory | engine `weavekit_*` (imported) | your store, per session |
| Id space | single internal uuid | whatever the resolver returns |
| `department` subtree, workflow assignees, audit actors | ✅ consistent | limited |
| Freshness | re-run `weave sync:identity` | instant |
| No local copy | — | ✅ |

## Verify

- **alice (sales)** → `search_records`/`get_record`/`create_record`/`update_record` (no delete), rows
  scoped to `owner_ref = alice`, `secret` stripped.
- **alex (manager)** → the `d-east` subtree, full CRUD.
- **Unknown on-behalf-of** → session rejected (`identity.notSynced` 403 on Path A; 400/401 on Path B).
- **Audit** — `actorId` is the internal user id (Path A) or the bearer value (Path B).

## Notes

- Path A keeps a **single id space**: row scopes, audit actors and workflow assignees never cross a
  source boundary.
- The `pg` source is read-only; the engine never writes your tables.
- Enterprise integrations (SCIM/LDAP/HRIS, OIDC/SAML) implement the same contracts — see
  [Identity](../../01-guides/04-access/03-identity.md).

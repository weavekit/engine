---
description: "Resolve agent and on-behalf-of identities from your own user table, so roles and teams stay current without a hardcoded list."
---

# Plugging in the customer's own user store

Instead of a static `auth.source` map and a static `mcp.identities` directory, both are **resolver functions** that load the customer's own users, roles and teams from their database. This is what you reach for when the user set is dynamic or already lives in the CRM's `crm_users` table.

## Background

[Integrating an existing CRM](existing-crm-to-mcp.md) keeps identity in config (`alice → sales`) — perfect for a handful of people. But real CRMs have user tables: people join, leave, change roles and teams. Maintaining a parallel hardcoded list in `weavekit.config.ts` becomes a second source of truth that drifts from the real one, and role changes mean editing config and restarting the engine.

This practice removes that duplicate: the engine asks *your* user store who a ref is, every time. Identity is always current, always consistent with the CRM.

## Benefits

- **No second source of truth** — roles and teams come from the customer's own `crm_users` table, not from a copy in config.
- **Changes apply instantly** — the resolver runs per session (and per call-level override), so a user's new role or team is picked up on the next connection; nothing to redeploy.
- **Reuses existing login/token infrastructure** — `auth.source` can verify your JWT/session instead of issuing separate API keys for the engine.
- **Fresh RBAC at every session** — the tool surface is compiled from the user's *current* roles, so a demoted manager loses manager tools without any config edit.
- **Scalable by nature** — user count no longer matters; it is one table lookup, not an ever-growing config file.

## When to use this

Choose resolver-driven identity (this practice) when:

- Users, roles or team membership change **frequently** — a static directory would require constant config edits and restarts.
- You already have a user store (`crm_users` or equivalent) and want the engine to be consistent with it — no parallel list to maintain.
- You need to integrate the engine with your existing **JWT / SSO / session** flow for the agent credential.
- You have **many** users — a static directory does not scale as a maintenance model.

If you have a handful of users and roles are stable, the [static-directory path](existing-crm-to-mcp.md) is simpler and equally valid — both approaches are interchangeable, not mutually exclusive.

## Scenario

- Customer table `crm_users(id, name, role, team_id)` holds their real users (e.g. `alice` / `sales`, `alex` / `manager`).
- Agent credentials are JWT-ish tokens verified by an `auth.source` resolver (`Bearer jwt-<id>` → agent subject).
- On-behalf-of refs resolve by querying `crm_users` — no hardcoded identity directory.

## 1. The customer's user table

```sql
CREATE TABLE crm_users (
  id      VARCHAR(36) PRIMARY KEY,   -- e.g. the on-behalf-of ref
  name    VARCHAR(255),
  role    VARCHAR(50) NOT NULL,      -- maps to a key in your schema permissions
  team_id VARCHAR(50)
);
INSERT INTO crm_users (id, name, role, team_id) VALUES
  ('alice', 'Alice Johnson', 'sales',   NULL),
  ('alex',  'Alex Carter',   'manager', 't1');
```

## 2. Objects with roles that match the user table

`objects/lead/schema.json` declares permissions keyed by role name — the same strings the resolver returns in `subject.roles`:

```jsonc
{
  "name": "lead",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "name", "type": "string" },
    { "name": "owner_id", "type": "string", "ownership": true },
    { "name": "secret", "type": "string" }
  ],
  "permissions": {
    "sales":   { "read": "own", "create": true, "update": ["name"], "delete": false, "fields": { "exclude": ["secret"] } },
    "manager": { "read": "all", "create": true, "update": true, "delete": true }
  }
}
```

## 3. Resolver-driven auth + identity in `weavekit.config.ts`

```ts
import { createPool } from '@weave-kit/engine';
import type { EngineConfig } from '@weave-kit/engine';

const pool = createPool(process.env.DATABASE_URL!);   // or pass pool.query in from your app

export default {
  schemaDir: '.',
  auth: {
    // resolver: verify the bearer token (a real deployment would verify a JWT
    // signature / expiry here). The full header is passed in.
    source: (header) => {
      const match = /^Bearer\s+jwt-(\w+)$/.exec(header ?? '');
      if (match === null) return null;
      return { id: `agent-${match[1]}`, roles: ['agent'] };
    },
  },
  adapters: {
    mcp: {
      identities: async (ref) => {
        // query the customer's own user table
        const res = await pool.query(
          `SELECT id, role, team_id FROM crm_users WHERE id = $1`,
          [ref],
        );
        const row = res.rows[0];
        if (row === undefined) return null;
        return {
          id: row.id,
          roles: [row.role],
          ...(row.team_id ? { teamId: row.team_id } : {}),
        };
      },
    },
  },
} satisfies EngineConfig;
```

Both fields are a union type: `Record<string, RbacSubject> | AuthResolver` for `auth.source` and `Record<string, RbacSubject> | IdentityResolver` for `mcp.identities`. A function wins when both are present.

## 4. Migrate and run

```sh
weave migrate        # lead table created (or validated if it already exists)
weave dev            # http://localhost:3000/mcp
```

## 5. Connect an agent

The two headers still drive identity, but now both resolve through your code:

| Header | Value in this case |
| --- | --- |
| `Authorization: Bearer jwt-1` | resolver → `{ id: 'agent-1', roles: ['agent'] }` (401 if the resolver returns null) |
| `X-Weavekit-On-Behalf-Of: alice` | resolver queries `crm_users` → `{ id: 'alice', roles: ['sales'] }` |

```ts
const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
  requestInit: {
    headers: {
      authorization: 'Bearer jwt-1',
      'x-weavekit-on-behalf-of': 'alice',
    },
  },
});
const client = new Client({ name: 'crm-agent', version: '1.0.0' });
await client.connect(transport);
```

## 6. Verify the end result

Run the case against your own PostgreSQL and check these behaviors:

- **alice (sales)** → `search_records` / `get_record` / `create_record` / `update_record` (no `delete_record`), rows scoped to `owner_id = 'alice'`, `secret` stripped. Works even though no identity was hardcoded in config — the resolver answered.
- **alex (manager)** → full CRUD on all rows.
- **Unknown on-behalf-of** → resolver returns null → session rejected (400), same as the static directory path.
- **Bad bearer** → resolver returns null → 401 before the transport.
- **Audit** — `actorId` is the raw bearer token value (`jwt-1`), `meta.onBehalfOf` is `alice`.

## Notes

- The resolver runs **per session establishment** (and per call-level `onBehalfOf` override), so the user's current roles/team are always fresh — no stale identity directory to redeploy.
- Resolvers may be async (they run inside async handlers); a sync resolver is fine too.
- If you only need the static directory, [integrating an existing CRM](existing-crm-to-mcp.md) shows that path — the two approaches are interchangeable, not mutually exclusive.

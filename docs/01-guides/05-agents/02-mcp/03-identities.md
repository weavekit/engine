---
title: Identities
description: "The on-behalf-of directory and plugging in your own user store via resolvers."
---

# Identities

An MCP session binds to an agent key (from `Authorization`) and an **on-behalf-of** identity (from
`X-Weavekit-On-Behalf-Of`). The on-behalf-of ref must resolve to a subject; RBAC then decides that
subject's tool surface.

`mcp.identities` is the static directory (`ref → IdentitySubject`). A session's proxied user must
resolve here; a missing or unknown ref is rejected at session establishment. When unset, the engine
resolves on-behalf-of refs through its own identity directory (`weavekit_user` — see
[Identity](../../04-access/03-identity.md)).

## Plugging in your own user store

Both `auth.source` and `mcp.identities` accept either a **static map** (the defaults) or a
**resolver function**, so you can drive authentication and on-behalf-of identity from your own
directory.

- `auth.source` — `Record<string, IdentitySubject> | AuthResolver`, where
  `AuthResolver = (header) => subject | null | Promise<...>`. The resolver receives the full
  `Authorization` header (including the `Bearer ` prefix) and may verify a JWT or look up the user
  asynchronously. Return `null` for unauthenticated (401). When an `identity.verifier` is configured,
  `auth.source` may be omitted (the verifier + engine directory authenticate instead).
- `mcp.identities` — `Record<string, IdentitySubject> | IdentityResolver`, where
  `IdentityResolver = (ref) => subject | null | Promise<...>`. The resolver may query your user table
  and return the subject with its roles and department. Return `null` for an unknown ref (the session
  is rejected with 400).

```ts
// weavekit.config.ts — auth + identities driven by the customer's user table
export default {
  schemaDir: '.',
  auth: {
    source: async (header) => {
      const token = header?.replace(/^Bearer\s+/i, '');   // verify your JWT here
      return token === undefined ? null : { id: `agent-${token}`, roles: ['agent'] };
    },
  },
  adapters: {
    mcp: {
      identities: async (ref) => {                          // query the customer's user table
        const row = await pool.query(
          `SELECT id, role, dept_id FROM crm_users WHERE id = $1`, [ref]);
        if (row.rows.length === 0) return null;
        const { id, role, dept_id } = row.rows[0];
        return { id, roles: [role], ...(dept_id ? { departmentId: dept_id } : {}) };
      },
    },
  },
} satisfies EngineConfig;
```

A resolver wins over the static map when both are provided for the same field. Either way, the tool
surface is compiled per identity and RBAC is re-enforced at call time — the double layer never changes.

For a database-backed directory, prefer the engine's own identity sync over hand-writing a resolver —
see [Identity](../../04-access/03-identity.md). For the runnable case (a customer user table + a JWT
auth source), see the [user-store practice](../../../03-practices/02-governance/02-bring-your-own-user-store.md).

## Impersonation

A call-level `onBehalfOf` tool argument lets an agent switch identity per call — **disabled by
default** (`mcp.impersonation` defaults to `off`). Set it to `'directory'` to allow switching to any
identity in the configured directory. The identity bound at handshake (`X-Weavekit-On-Behalf-Of`) is
always enforced.

## Related

- [MCP overview](01-overview.md)
- [Tool surface](02-tool-surface.md)
- [Identity](../../04-access/03-identity.md) — the engine directory and sync
- [RBAC](../../04-access/02-rbac.md)

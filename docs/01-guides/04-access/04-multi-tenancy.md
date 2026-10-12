---
title: Multi-tenancy (row)
description: "Scope reads and writes to a subject's scope with one field marker — RBAC, RLS and audit together."
---

# Multi-tenancy (row)

WeaveKit's tenancy is **row-based**: one database, one set of tables, and a scope column that fences
every row. It is **opt-in** and **per object** — an object without a scope column behaves exactly as
before, and a subject without a scope runs single-scope.

## Enable

```ts
// weavekit.config.ts
export default {
  // ...
  scope: { enabled: true, defaultScope: 'acme' },
};
```

When `scope.enabled` is on, a subject that lacks a scope is stamped with `defaultScope`
(`withDefaultScope`), so existing auth sources keep working. Then mark **one** field on each
scope-fenced object:

```jsonc
// objects/invoice/schema.json
{
  "name": "invoice",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "tenant_id", "type": "string", "scope": true },
    { "name": "amount", "type": "number" }
  ]
}
```

The `"scope": true` marker is engine-recognized (not a name convention). You choose the column name.

## How isolation is enforced (three layers)

- **RBAC row scope** — `buildRowScope` ANDs a `scope = <subject.scopeId>` predicate onto every read,
  **even for `read: "all"`**. A query run as an agent on behalf of another scope simply returns
  nothing.
- **Native PostgreSQL RLS** — the policy adds
  `current_setting('weavekit.scope_id', true) = "<col>"`. The restricted-SQL role (`this.db.query`)
  sets the `weavekit.scope_id` GUC, so a GUC-less query **fails closed** (reads zero rows, never
  over-exposes). With [`rls.enforce`](02-rbac.md#database-enforced-row-scope-rlsenforce) the
  engine's own object queries are bounded by the same scope predicate in PostgreSQL as well.
- **Audit** — every event carries `scopeId`; the audit query and SSE stream filter by the subject's
  scope, so an ordinary identity only sees its own scope's trail.

## Write rules

- **Forced on create** — the scope column is set from the subject; a client cannot create a row in
  another scope (the input value is ignored).
- **Immutable on update** — moving a row to another scope is rejected with `object.scope.immutable`.
  There is no reassignment path.
- Cross-scope writes are invisible to the row scope, so they surface as `data.recordNotFound`.

## System actors

A `system` principal may carry a scope (`systemPrincipal(capability, reason?, scopeId?)`) so background
work (workflow timers, timers/scripts) is confined to the right scope. Without a scope it is
unrestricted, as in single-scope mode.

## Scope boundary

Tenant **lifecycle** (onboarding, offboarding, data residency) and **schema-per-tenant** isolation are
the enterprise layer. The engine provides exactly the row mechanism above and the seams to build on.

## Related
- [RBAC](02-rbac.md) — the row-scope / permission model the scope predicate layers on
- [Identity](03-identity.md) — where `subject.scopeId` comes from
- [Audit](../09-platform/03-audit.md) — `scopeId` on events and the scope-scoped query
- [Enterprise seams](../../04-reference/04-enterprise-seams.md)

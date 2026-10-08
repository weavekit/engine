---
title: Multi-tenancy (row)
description: "Scope reads and writes to a subject's tenant with one field marker — RBAC, RLS and audit together."
---

# Multi-tenancy (row)

WeaveKit's tenancy is **row-based**: one database, one set of tables, and a tenant column that fences
every row. It is **opt-in** and **per object** — an object without a tenant column behaves exactly as
before, and a subject without a tenant runs single-tenant.

## Enable

```ts
// weavekit.config.ts
export default {
  // ...
  tenants: { enabled: true, defaultTenant: 'acme' },
};
```

When `tenants.enabled` is on, a subject that lacks a tenant is stamped with `defaultTenant`
(`withDefaultTenant`), so existing auth sources keep working. Then mark **one** field on each
tenant-scoped object:

```jsonc
// objects/invoice/schema.json
{
  "name": "invoice",
  "fields": [
    { "name": "id", "type": "string", "primary": true },
    { "name": "tenant_id", "type": "string", "tenant": true },
    { "name": "amount", "type": "number" }
  ]
}
```

The `"tenant": true` marker is engine-recognized (not a name convention). You choose the column name.

## How isolation is enforced (three layers)

- **RBAC row scope** — `buildRowScope` ANDs a `tenant = <subject.tenantId>` predicate onto every read,
  **even for `read: "all"`**. A query run as an agent on behalf of another tenant simply returns
  nothing.
- **Native PostgreSQL RLS** — the policy adds
  `current_setting('weavekit.tenant_id', true) = "<col>"`. The restricted-SQL role (`this.db.query`)
  sets `SET LOCAL weavekit.tenant_id`, so a GUC-less query **fails closed** (reads zero rows, never
  over-exposes).
- **Audit** — every event carries `tenant_id`; the audit query and SSE stream filter by the subject's
  tenant, so an ordinary identity only sees its own tenant's trail.

## Write rules

- **Forced on create** — the tenant column is set from the subject; a client cannot create a row in
  another tenant (the input value is ignored).
- **Immutable on update** — moving a row to another tenant is rejected with
  `object.tenant.immutable`. There is no reassignment path.
- Cross-tenant writes are invisible to the row scope, so they surface as `data.recordNotFound`.

## System actors

A `system` principal may carry a tenant (`systemPrincipal(capability, reason?, tenantId?)`) so
background work (workflow timers, timers/scripts) is confined to the right tenant. Without a tenant it
is unrestricted, as in single-tenant mode.

## Scope boundary

Tenant **lifecycle** (onboarding, offboarding, data residency) and **schema-per-tenant** isolation are
the enterprise layer. The engine provides exactly the row mechanism above and the seams to build on.

## Related
- [RBAC](02-rbac.md) — the row-scope / permission model the tenant predicate layers on
- [Identity](03-identity.md) — where `subject.tenantId` comes from
- [Audit](../09-platform/03-audit.md) — `tenant_id` on events and the tenant-scoped query
- [Enterprise seams](../../04-reference/04-enterprise-seams.md)

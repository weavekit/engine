---
title: "Migrating to 2.0"
description: "Breaking changes in @weave-kit/engine 2.0 (CONTRACT_VERSION 2): the shared contract package, `tenant`→`scope`, and the retired layout/pages groundwork."
---

# Migrating to 2.0

2.0 is a **breaking** release: `CONTRACT_VERSION` is bumped `1 → 2`. It is additive for new projects;
the changes below matter when upgrading an existing 1.x project.

## 1. Shared `@weave-kit/contract` package

The shared type/value vocabulary (schema, query, REST, audit, approvals, workflow schema, metadata
descriptor) moved into the zero-dependency **`@weave-kit/contract`** package:

- `@weave-kit/contract` — pure types.
- `@weave-kit/contract/values` — the `as const` runtime values (browser-safe).

`@weave-kit/engine` re-exports this surface, so existing `@weave-kit/engine` imports keep working.
`@weave-kit/client` 2.0 now depends on `@weave-kit/contract` **instead of** the engine (it no longer
pulls the Node server runtime). If you import engine types in front-end code, prefer
`@weave-kit/contract`.

## 2. `tenant` removed — `scope` is the single row-scope name

The `tenant` alias is gone. Use `scope`:

| Was (1.x) | Is (2.0) |
| --- | --- |
| `{ "name": "t", "type": "string", "tenant": true }` | `{ ..., "scope": true }` |
| `EngineConfig.tenants = { enabled, defaultTenant }` | `EngineConfig.scope = { enabled, defaultScope }` |
| `withDefaultTenant(auth, t)` | `withDefaultScope(auth, s)` |
| `principalTenantId(p)` / `tenantOf(ctx)` | `principalScopeId(p)` / `scopeOf(ctx)` |
| `subject.tenantId` / event `tenantId` | `subject.scopeId` / event `scopeId` |
| GUC `weavekit.tenant_id` | `weavekit.scope_id` |
| audit column `weavekit_audit.tenant_id` (+ `_tenant_idx`) | `scope_id` (+ `weavekit_audit_scope_idx`) |
| error code `object.tenant.immutable` | `object.scope.immutable` |

**Database:** existing `weavekit_audit` tables keep their old `tenant_id` column; `weave migrate`
adds `scope_id` alongside it (additive). The old column is unused — drop it yourself once you no
longer need the data.

## 3. Retired layout/pages groundwork and `--type=business`

The business-UI groundwork (retired in 2026-10) is now **deleted**:

- removed: `src/layout-format.ts`, runtime/git `layoutSource`/`pageCatalog`/`pageScripts`, the REST
  `pages` routes, and the `default-view` / `pages:migrate` commands;
- `--type=business` is removed: `PROJECT_TYPES` is **`agent | governance | service`**. Use `service`
  (script hooks) for a headless business backend.

## Related
- [Contract freeze](03-contract-freeze.md)
- [Enterprise seams](04-enterprise-seams.md)

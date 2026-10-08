---
description: "Which parts of `@weave-kit/engine` are safe to build on, which are still moving, and how the package enforces the boundary."
---

# Public API & dependency budget

Not every import is a promise. This page tells you which parts of `@weave-kit/engine` are safe to
build on, which are still moving, and how the two are kept apart. It is the contract that downstream
packages (the client SDK) and external integrators code against.

## Entry points — three tiers

| Import | Tier | Promise |
| --- | --- | --- |
| `@weave-kit/engine` | **stable** | app / integration contract; breaking changes only in a major release |
| `@weave-kit/engine/values` | **stable** (browser-safe) | pure `as const` constants (field types, filter ops, …); zero imports |
| `@weave-kit/engine/experimental` | **experimental** | under active development; **may change in a minor release** |
| any other path | **internal** | not importable — blocked by the `exports` map (even `dist/…` deep paths) |

`values` is a separate subpath for one reason: it must stay free of the Node server runtime
(`pg` / `fastify` / `isolated-vm`) so it can be bundled anywhere, including the browser.

The stable entry covers engine assembly (`createEngine`, `buildEngineFromRegistry`), the core
contracts (`core/*`), data access, identity (the `core/provider/identity` contracts; `runIdentitySync`,
`createPgIdentitySource`, `createFunctionIdentitySource`, `PgIdentityStore`, `PgIdentityDirectory`,
`IdentityAdmin`, `createDirectoryAuthenticator`, `enforceSyncedIdentity`), [Git metadata
sync](../../01-guides/03-model/04-git-versioned-metadata.md), custom tools, the generic proxy, the protocol adapters
(auth/rest/mcp/events/graphql), the OpenAPI document generator (`buildOpenApiDocument`), the GraphQL
schema builder (`buildGraphQLSchema` / `registerGraphQL`), the named-enum
registry (`EnumDefinition` / `EnumRegistry` / `buildEnumRegistry` / `validateEnumDefinition` /
`loadEnumsDir` / `resolveEnumRegistry`), the audit/script
contract types, and the scaffolder (`scaffoldProject`, `PROJECT_TYPES`).

The experimental entry covers the moving parts that aren't worth freezing yet: the
`infrastructure/*` provider implementations, the metadata cache, the tunnel transport, and the ops
(health/ready) routes.

> The tier boundary is enforced by `tests/unit/public-api.test.ts`: the stable entry must expose the
> contract names and must **not** leak internals, while the experimental entry must expose them. When
> you move a module between tiers, update that test and this page in the same change.

## Extension points

The stable surface exists so you can extend the engine without patching internal paths:

- **Auth / identity** — `auth.source` and `mcp.identities` accept resolvers, or configure
  `identity.verifier` + the engine directory. Identity sources implement the `core/provider/identity`
  contracts (`IdentitySource` / `AuthVerifier` / `IdentityDirectory` / `IdentityStore`) and are
  **config-injected** (no global registry); the engine ships the `pg` and `function` sources (see
  [Identity](../../01-guides/04-access/03-identity.md)).
- **Providers** — implement the `core/provider/*` contracts (alerts, identity, event) and inject them; implementations live outside `core`.
- **Subsystems** — enabled through `weavekit.config.ts` and dynamically loaded.
- **Custom tools & guardrail policies** — `core/tools` + `runtime/tools`.
- **Custom field types** — `loadFieldTypesDir` / `resolveFieldTypeRegistry` + config `fieldTypes`; a
  project-local `field-types/` dir of declarative registrations (see
  [Custom field types](../02-schema/02-custom-field-types.md)).
- **Named enums** — `enums/<name>.json` declarations referenced by `enumType`, loaded via
  `loadEnumsDir` / `resolveEnumRegistry` (see
  [Named enums](../../01-guides/03-model/02-schema/06-named-enums.md)).
- **Generic proxy** — `proxy.resolver` carries the application semantics.
- **Protocol adapters** — the `adapters/*` registration functions.

## Recent additions (0.9 / 0.10 / 0.11)

- **Execution pipeline + evidence contracts** — `EXECUTION_STAGES` / `ExecutionPlan` / `Evidence` /
  `EvidenceSink` (`core/tools/pipeline.ts`); `runPipeline` (`runtime/execution/pipeline.ts`)
  orchestrates Plan→Validate→Authorize→Guardrail→Approval→Execute→Commit→Evidence;
  `validateToolArgs` (`core/tools/validate-args.ts`)
  validates tool arguments against the declared `ToolJsonSchema` (MCP + custom tools).
- **QueryBudget** — `QueryBudget` / `QUERY_BUDGET_DEFAULTS` / `resolveQueryBudget` /
  `assertQueryBudget` (`runtime/data-access/query-budget.ts`); config `EngineConfig.queryBudget`.
  Bounds rows/filters/sorts (data-access), joins / SQL length / statement timeout (restricted SQL)
  and GraphQL depth.

- **Deploy & schema revision** — `weave deploy plan|apply`; `computeSchemaHash` /
  `writeSchemaRevision` / `latestSchemaRevision` (`runtime/metadata`).
- **Audit durability** — `subsystems.audit.mode` (`best-effort` | `transactional` | `durable`),
  `AUDIT_MODES`, `AuditSink.recordInTx`.
- **Access principal** — `AccessPrincipal` / `SYSTEM_CAPABILITIES` / `userPrincipal` /
  `systemPrincipal` (`core/types/principal.ts`). `DataAccessContext.principal` is **required** (the
  implicit `subject` field was removed — a missing actor is a compile error, not an unrestricted
  bypass).
- **Cursor pagination** — `FindOptions.cursor` + `FindResult.nextCursor`/`hasMore`;
  `encodeCursor` / `decodeCursor` (`runtime/data-access`).

## Dependency budget

A headless engine should install anywhere and start fast, so the dependency surface is a product
feature, not an accident:

- `core/` — **zero dependencies** (types, pure functions, `as const` values).
- `runtime/` — Node built-ins (`node:*`) only; no third-party runtime imports beyond the platform required by the layer.
- A new **runtime** dependency needs a written justification. Prefer a Node built-in, the way the proxy uses the global `fetch` and `AbortSignal.timeout` instead of an HTTP client.
- **Native / optional** dependencies (such as `isolated-vm`) belong in `optionalDependencies` and must degrade with an actionable error when absent — users who don't use a feature shouldn't pay for it.
- `./values` must never gain a runtime import (guarded by `tests/unit/values-browser-safe.test.ts`).

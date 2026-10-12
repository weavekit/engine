# Changelog

All notable changes to `@weave-kit/engine`. Format follows [Keep a Changelog](https://keepachangelog.com/);
the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-10-12

Additive + internal (no `CONTRACT_VERSION` bump).

### Added

- **Optional stateless Streamable HTTP for MCP** (`adapters.mcp.stateless`, default off). Each request
  is self-contained (no server-side session), so the engine scales horizontally **without sticky
  routing**; the `X-Weavekit-On-Behalf-Of` header must accompany every request. The default stays
  stateful (needs sticky routing). See the MCP overview.

### Changed

- **Internal maintainability refactor (no behavior change).** The object data-access pure helpers
  moved to `runtime/data-access/query-helpers.ts` (`query.ts` 1293 → 1049 lines); the engine assembly
  config types, start-up guards and HTTP route registration moved to `runtime/config-types.ts`,
  `runtime/guards.ts` and `runtime/register-http-routes.ts` (`engine.ts` ~1130 → ~480 lines). The
  public export surface is unchanged.
- Removed residual duplicate `scopeId` keys/spreads left by the 2.0 `tenant`→`scope` rename.

## [2.0.0] - 2026-10-12

**Breaking** — `CONTRACT_VERSION` 1 → 2.

### Changed

- **Shared `@weave-kit/contract`.** The shared type/value vocabulary (schema, query, REST, audit,
  approvals, workflow schema, metadata descriptor) now lives in the zero-dependency
  `@weave-kit/contract` package (types + `./values`); the engine re-exports it. `@weave-kit/client`
  now depends on the contract instead of the engine.
- **`tenant` removed — `scope` is the single row-scope name.** Removed: the `tenant: true` field
  marker (`ROW_SCOPE_MARKERS.TENANT`), `EngineConfig.tenants`, the `weavekit.tenant_id` GUC,
  `withDefaultTenant`, `principalTenantId`, `tenantOf`, the `.tenantId` property on
  `IdentitySubject`/`AuditEvent`/`DataAccessContext`, and the `weavekit_audit.tenant_id` column/index
  (now `scope_id` / `weavekit_audit_scope_idx`). Use `scope` / `scopeId` / `EngineConfig.scope` /
  `weavekit.scope_id`. The `object.tenant.immutable` error code is now `object.scope.immutable`.

### Removed

- The retired layout/pages groundwork: `src/layout-format.ts`, runtime/git `layoutSource` /
  `pageCatalog` / `pageScripts`, the REST `pages` routes, the `default-view` and `pages:migrate`
  commands, and `--type=business` (`PROJECT_TYPES` = agent | governance | service; `businessUI` /
  `isBusinessUI` gone).

## [1.8.0] - 2026-10-12

Additive (no `CONTRACT_VERSION` bump).

### Added

- **`weave doctor --report [path]`** — write a **redacted, local-only** deployment profile (JSON,
  default `weavekit-report.json`): engine/runtime versions, enabled subsystems/adapters, capability
  switches (`rls.enforce`, tenants, scope, `systemSchema`, …) and object/field-count buckets, plus the
  doctor check statuses. It contains no hosts, URLs, ids, object names or other customer data and is
  never uploaded (the engine has no telemetry). New export `buildDeploymentReport`.

## [1.7.0] - 2026-10-12

Additive (no `CONTRACT_VERSION` bump): built-in OIDC/JWT auth + MCP OAuth discovery.

### Added

- **Built-in OIDC/JWT verifier (`auth.oidc`).** The engine validates bearer JWTs locally — JWKS
  (explicit `jwksUri` or OIDC discovery from `issuer`), `iss`/`aud`/`exp`/`nbf` with clock skew, and
  **asymmetric algorithms only** (never `none`/HMAC) — and resolves them to the identity directory
  (`ref` from `subjectClaim`, default `sub`; `rolesClaim`/`tenantClaim` surfaced as `claims.roles` /
  `claims.tenantId`). `auth.source` is now optional and `auth` may carry `oidc`. Powered by `jose`.
  New exports `createOidcVerifier`, `OidcConfig`.
- **MCP OAuth Protected Resource Metadata (RFC 9728).** With `auth.oidc`, `GET
  /.well-known/oauth-protected-resource` advertises `authorization_servers` (default `[issuer]`,
  override `auth.oidc.authorizationServers`) and 401 responses carry a
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge — so standards-based MCP hosts (Claude,
  ChatGPT connectors, VS Code) can discover and run the OAuth flow. New exports
  `oauthProtectedResourceMetadata`, `wwwAuthenticateChallenge`, `OAUTH_PROTECTED_RESOURCE_PATH`.

### Changed

- **E1 boundary:** OIDC/JWT is now **MIT** (built-in `auth.oidc`). `@weave-kit/enterprise` E1 now
  covers SAML, SCIM/LDAP/HRIS directory sync, group→role mapping, multi-IdP and identity-event audit.
  The `AuthVerifier` seam stays open for custom/SAML verifiers.

## [1.6.0] - 2026-10-12

Additive (no `CONTRACT_VERSION` bump): a dedicated system schema for brownfield installs.

### Added

- **`EngineConfig.systemSchema`** — create the engine's own tables (the `weavekit_*` system tables,
  the `weavekit_record__<object>` metadata side tables and the `weavekit_m2m__*` link tables) in a
  **dedicated schema** instead of the object schema, so a DBA reviewing the customer schema does not
  see engine plumbing. `weave migrate` / `weave deploy` create the schema and qualify those tables
  (explicit qualification — object tables stay in the object schema); the runtime appends the schema to
  `search_path` so its unqualified engine-table references resolve there. `MigrateOptions.systemSchema`,
  `weave doctor` checks the dedicated schema, and `inspectSchema` takes a `schema` option. New exports
  `SchemaScope`, `createSchemaScope`, `qualifyTable`, `assertSchemaName`, `searchPathOptions`.
  Default (`undefined`) is unchanged; existing installs move tables manually
  (`ALTER TABLE … SET SCHEMA`).

## [1.5.0] - 2026-10-12

Additive (no `CONTRACT_VERSION` bump): P0 security/governance fixes.

### Added

- **Object-path RLS (`rls.enforce`, default off).** `EngineConfig.rls = { enforce?, role? }`: the
  engine runs user-principal customer-table reads / updates / deletes under a restricted role
  (`weavekit_object`) with the subject in `weavekit.*` GUCs, so PostgreSQL re-checks the RBAC row
  scope. Policies (`weavekit_obj_select|update|delete`, `TO <role>`) are generated from the same
  row-scope builder as the application layer (department subtree, external ids, details through the
  parent, `scope`/`tenant` boundary). `weave migrate` / `weave deploy` / `migrate.auto` provision the
  role, policies and grants (`MigrateOptions.objectRls`); existing tables only with `"alter": true` and
  ownership. Fail-closed startup (`engine.rls.notProvisioned`) and a `weave doctor` `object-rls` check.
  Inserts and system principals still run as the owner. New exports: `buildObjectRlsPolicies`,
  `planObjectRls`, `diffObjectRls`, `diffGrants`, `rlsPolicyComment`, `OBJECT_RLS_POLICIES`,
  `OBJECT_RLS_ROLE_DEFAULT`, `resolveObjectRlsRole`, `assertObjectRlsProvisioned`.
- **Protocol parity e2e.** REST / GraphQL / MCP return the same rows, excluded fields, error codes and
  messages, audit trail and evidence for the same identity (with and without `rls.enforce`).
- **Configurable list `total`.** `EngineConfig.query.total` — and a per-request `total=` on REST /
  GraphQL / MCP (client `FindParams.total`) — selects `exact` (default, `COUNT(*)`), `estimate`
  (`pg_class.reltuples`; cheap on large tables, approximate) or `none` (skip counting). New data-access
  export `buildEstimateSql`, `TOTAL_MODES` / `TotalMode`.
- **`weave doctor` RLS-role check.** New `role-createrole` check: when a required RLS role
  (`weavekit_query`, the object-path role) is missing and the migration account lacks `CREATEROLE`,
  doctor fails and prints the exact `CREATE ROLE …` to run (as an owner/DBA).

### Changed

- **Evidence covers every write.** With `evidence.enabled`, every data-access create / update / delete,
  workflow transition and tool call records one row **after** execution with its real outcome
  (`execute: error` + code on failure) — previously only policy-gated writes, recorded before
  execution with plan/guardrail stages only. Data-access writes now run through `runPipeline`;
  without policies, approvals or evidence the write path is unchanged. Evidence stays best-effort.
- The script read policy carries a definition digest (`COMMENT ON POLICY`): a changed permission
  matrix now recreates it on migrate (previously only a missing policy name was detected). The first
  migrate after upgrading recreates existing script policies once.
- Restricted-SQL GUCs are set with one parameterized `set_config` statement (shared with the object
  path); absent values are set to `''` (still fail-closed).
- **`--type=governance` scaffolds audit on.** The governance preset emits
  `subsystems.audit = { enabled: true, mode: 'transactional' }` (crash-safe); the other presets leave
  audit off (enable it in production — see the audit guide).
- **List `total` may be omitted.** `FindResult.total` and the REST list envelope `total` are now
  optional, and GraphQL `<Object>Page.total` is nullable — a request with `total=none` omits it.
  Existing callers (default `exact`) are unaffected.

### Fixed

- **`submit` ignored the row scope**: any identity with update permission could submit another
  user's record into its workflow. `submit` now requires the record inside the caller's manage scope;
  approve / reject / forward / withdraw / cancel keep workitem / originator authorization.
- **Workflow status / history ignored the row scope**: they now require the record in the caller's
  read scope or participation (originator / any workitem).
- An `UPDATE` that matches no row (e.g. blocked by a policy) now fails with `data.recordNotFound`.

### Removed

- Internal dead field `CompiledTool.objectName` — always `undefined` since the fixed-registry MCP
  surface (a9263c3) and never read (the audit's `objectName` comes from the runtime `object`
  argument). No behavior change.

## [1.4.0] - 2026-10-11

Additive (no `CONTRACT_VERSION` bump): MCP prompts.

### Added

- **MCP prompts.** The third MCP primitive: user-invoked templates. Built-in, **schema-derived** and
  RBAC-filtered prompts (`explore_data`, `object_guide`, `build_filter`, `run_workflow` — names frozen
  in `BUILTIN_PROMPTS`), plus a host `PromptsProvider` seam for business prompts
  (`adapters.mcp.prompts.provider`; `builtins` / `enabled` toggles). The server now advertises a
  `prompts` capability; built-in names are reserved and cannot be shadowed by a provider.

## [1.3.0] - 2026-10-11

Additive (no `CONTRACT_VERSION` bump): MCP surface + formula catalog.

### Added

- **MCP approval tools.** When an approval queue is wired and the session identity holds an
  `adapters.mcp.adminRoles` role, the surface exposes `list_approvals` / `approve_approval` /
  `reject_approval` (names frozen in `APPROVAL_TOOLS`). Resolution is audited by the queue facade and
  the tool call by `callProtected` — the same admin gate as the REST `/approvals` routes.
- **MCP resources.** The schema is exposed as readable resources (`weavekit://objects`,
  `weavekit://objects/{name}`), derived from the registry and RBAC-filtered per identity (mirrors
  `list_objects` / `describe_object`). The server now advertises a `resources` capability.
- **Formula catalog.** New functions (single-source `FORMULA_FUNCTIONS`): `lower` / `upper` / `trim` /
  `length` / `substr` / `replace`, `abs` / `floor` / `ceil` / `pow`, and null-coalescing `coalesce`,
  with arity/type validation.

## [1.2.0] - 2026-10-11

Additive (no `CONTRACT_VERSION` bump): seams for the Cloud/Console control plane.

### Added

- **Generic row-scope (`scope`).** The canonical twin of `tenant`: a field marked `"scope": true`
  scopes reads/writes to `subject.scopeId ?? subject.tenantId` — RBAC row scope + native RLS
  (`weavekit.scope_id` GUC; `weavekit.tenant_id` retained and set alongside) + audit (`scopeId`).
  `EngineConfig.scope`, `withDefaultScope`, `principalScopeId` / `scopeOf` / `scopedKey`, and the
  `scopeId` alias on `IdentitySubject` / `AuditEvent` / `AuditQuery` / SSE events are additive; the
  `tenant` names keep working.
- **REST `principalFor` seam.** `EngineRestConfig.principalFor` maps an authenticated request to an
  `AccessPrincipal`, letting a control plane run requests under a **system/admin scope**
  (`systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN)`) for cross-tenant global views.
- **Identity sync trigger.** `POST {prefix}/identity/sync` (admin-gated) runs the configured
  `identity.source` (`runIdentitySync`) on demand — the manual projection step for site members
  (`dryRun` supported).
- **Capabilities read seam.** `EngineConfig.capabilities.provider` + `GET {prefix}/capabilities`
  (baseline + host-injected `Capabilities`). The engine surfaces entitlements verbatim and never
  judges licensing.
- **Identity admin write completeness.** `IdentityStore`/`IdentityAdmin` gain `updateUserRoles` /
  `deleteUser` / `createDepartment` / `listDepartments` (rows now carry `name`/`email`/`mobile`,
  departments `name`/`code`). REST adds `PATCH` roles on `/identity/users/:id`, `DELETE`
  `/identity/users/:id`, and `/identity/departments` (`GET`/`POST`); CLI adds
  `weave identity:set-roles` / `weave identity:delete`.

## [1.1.0] - 2026-10-10

### Removed

- **Business-UI groundwork retired.** `--type=business` no longer emits `objects/<name>/*.client.js`
  or `pages/<name>/*.layout.json`, and the `./layout` package export (page-layout format) was
  removed. The engine stays headless — there is no in-project renderer. `PROJECT_TYPE_DEFINITIONS[*]
  .businessUI` is now always `false`; the layout format and the `pages` REST routes remain
  frozen/internal. No `CONTRACT_VERSION` bump: the removed surface was pre-release and never
  documented or exposed in OpenAPI.

## [1.0.0]

The **G1 contract-freeze** release: the public surface (schema/workflow formats, REST routes, MCP tool
names, event types, error codes, data-access/RBAC contracts, package exports) is now frozen under
`CONTRACT_VERSION` (`1`) and evolves **additively** from here. It also lands multi-tenancy, the
observability seam and operational tooling.

### Added

- **Multi-tenancy (row).** `EngineConfig.tenants = { enabled?, defaultTenant? }`; an object field
  marked `"tenant": true` scopes every read/write to the subject's tenant — RBAC row scope (even for
  `read: "all"`) + native RLS (`weavekit.tenant_id` GUC) + audit (`tenant_id`). The tenant is forced
  on create and immutable on update (`object.tenant.immutable`); `withDefaultTenant` stamps a subject
  that lacks one. Absent tenant = single-tenant (unchanged). Exported `principalTenantId`, `tenantOf`,
  `scopedQuotaKey`, `ROW_SCOPE_MARKERS.TENANT`.
- **Contract freeze (G1).** `CONTRACT_VERSION` (exported from the package root; mirrored in
  `GET /version` and the OpenAPI `info.x-contract-version`) plus a freeze gate test and the
  contract-freeze / deprecation policy.
- **Observability seam.** `MetricsSink` / `TraceSink` + single-source `METRIC_NAMES`
  (`core/observability`), injected via `EngineConfig.observability`; the engine emits request
  latency/status, `rbac.deny` and `query.budget.reject`, and records spans. `core/trace.ts`
  (`parseTraceparent`) parses the inbound W3C `traceparent`; the `traceId` threads through
  audit / evidence / events. No-op default; no telemetry backend bundled.
- **`weave doctor` preflight** — read-only (connection, PostgreSQL compatibility, schema↔DB drift,
  engine system tables, RLS role + sandbox), `--json` supported; `weave migrate --preflight` runs it
  first and aborts on any failure.
- **`weave deploy plan` schema-impact analysis** (`analyzeImpact` / `SchemaImpact`): creates, column
  adds, constraints, indexes, enum + RLS changes, a data-compat risk and an API-breaking flag, plus
  the live schema revision and a **config-drift** flag.
- **Audit + evidence keyset cursor.** `AuditQuery.cursor` / `AuditQueryResult.nextCursor` and
  `EvidenceQuery` / `EvidenceQueryResult` + `queryEvidence` (stable `(ts DESC, id DESC)` paging;
  offset still supported).
- **Enterprise seams** documented and annotated (`@enterprise-reserved`): `AuditSink`,
  `ApprovalsBackend`, `WorkflowTimerStore` / `WorkflowBackend`, `IdentityStore`,
  `AuthSource` / `AuthVerifier`, `GuardrailPolicy`, `ProxyTargetResolver`, `MetricsSink` / `TraceSink`.

### Changed

- **GraphQL query cost is weighted by the list `limit`** (was a raw field count), matching the
  documented behavior.
- Query-budget filter counting is robust against malformed `$or` groups.

### Fixed

- **System-principal audit `actorId` is `'system'`** again (matches the documented contract; the
  specific capability is kept on the event's `meta.capability`).
- **Tenant write isolation**: `create` forces the tenant column to the subject's tenant, and `update`
  rejects moving a row to another tenant (`object.tenant.immutable`).
- MCP argument-validation denials are audited under `tool.args.invalid` (not `mcp.tool.notFound`).

### Removed

- `EngineAuditConfig.retention` — the no-op placeholder is gone (retention / export / compliance are
  the enterprise E2 layer).

## [0.11.0]

### Added

- **Agent Execution pipeline + Evidence.** A protocol-agnostic orchestrator (`runPipeline`,
  `EXECUTION_STAGES` / `ExecutionPlan` / `Evidence` / `EvidenceSink`) runs one execution through
  Plan → Validate → Authorize → Guardrail → Approval → Execute → Commit → Evidence. The custom-tool
  executor and the data-access write path (`create`/`update`/`delete`, action
  `object.<object>.<op>`) now share the same guardrail/approval gate, so REST / MCP generic CRUD /
  GraphQL / script writes are all covered (previously only custom tools and workflow transitions
  were). Tool arguments are validated against the declared `ToolJsonSchema` (`tool.args.invalid`).
  Enable `evidence.enabled` to record one `weavekit_evidence` row per gated execution
  (request/trace/schema-revision correlated). Additive — with no guardrail policies configured and
  evidence disabled, behavior and queries are unchanged.

### Fixed

- Guardrail/approval is no longer bypassed by MCP generic CRUD and REST writes (new action
  `object.<object>.<op>`).

## [0.10.0]

### Added

- **QueryBudget.** `EngineConfig.queryBudget` bounds a read/query across the engine:
  rows / filters / sorts in data-access (all list paths), joins / SQL length / statement timeout in
  restricted SQL (`this.db.query`), and GraphQL depth. Exported `QueryBudget` / `QUERY_BUDGET_DEFAULTS`
  / `resolveQueryBudget` / `assertQueryBudget` (`runtime/data-access/query-budget.ts`); a per-context
  `DataAccessContext.budget` overrides the instance default. Additive — default limits only.

## [0.9.0]

A **breaking** consistency/authorization release. Read the **Breaking** section before upgrading.

### Breaking

- **`DataAccessContext.principal` is now required; the implicit `subject` field is removed.** The old
  convention — omit `subject` and get unrestricted access — is gone, so a forgotten actor is now a
  **compile error** instead of a silent RBAC bypass. Migrate:
  - a user call → `principal: userPrincipal(subject)` (or a literal `{ kind: 'user', subject }`);
  - an internal/seed/system call → `principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN)`
    (or `{ kind: 'system', capability: 'internal.admin' }`).
  `AccessPrincipal`, `userPrincipal`, `systemPrincipal` and `SYSTEM_CAPABILITIES` are exported from
  the package root. `withRbac` passes through only for an explicit **system** principal.

### Added

- **Global schema revisions + atomic deploys.** New `weavekit_schema_revision` (append-only, anchored
  on a deterministic aggregate `computeSchemaHash(files)`). `weave migrate` / `weave deploy apply` now
  commit the DDL, the metadata cache and the schema revision in **one transaction** (serialized by an
  advisory lock) — a failure rolls the whole deploy back. New CLI: `weave deploy plan` (read-only
  preview + risk) and `weave deploy apply`.
- **Audit durability modes.** `subsystems.audit.mode`: `best-effort` (default, unchanged),
  `transactional` (audit row written in the business transaction) and `durable` (transactional outbox
  `weavekit_audit_outbox` + a crash-safe, at-least-once relay). New `AuditSink.recordInTx(event,
  client)` seam; audit events gain `requestId` / `traceId` (new indexed columns).
- **Cursor pagination.** `FindOptions.cursor` + `FindResult.nextCursor` / `hasMore` (opaque keyset on
  the single primary key). MCP `search_records` accepts `cursor` and returns `hasMore`/`nextCursor`;
  offset remains supported.
- **Access principal types** (`core/types/principal.ts`): `AccessPrincipal`, `SYSTEM_CAPABILITIES`,
  `userPrincipal`, `systemPrincipal`, `principalSubject`, `principalActorId`.

### Changed

- **MCP compiled-surface cache** key now includes a schema signature (registry-derived) and the
  custom-tool set, and the cache is bounded — a schema/tool change no longer serves stale tools.
- **Workflow privileged operations** (`releaseWorkflowLock` / `workflowTodos` / `overrideWorkflow`)
  are now guarded in the RBAC decorator (fail-closed read/update checks) instead of passing through.

### Fixed

- **Implicit-unrestricted holes** in the custom-tool base context and the transition guardrail
  context: both now carry a user principal, so a tool/policy cannot read unrestricted by omission.

## [0.8.0]

### Added

- **GraphQL adapter (opt-in).** `adapters.graphql` compiles the same `schema.json` into a read/write
  GraphQL endpoint (`/graphql`, POST + GET) that reuses the engine's RBAC / RLS / audit unchanged:
  queries (`<object>` pages + `<object>_by_id`, with nested relations batched per request),
  mutations (`create`/`update`/`delete` plus workflow `transition`), query hardening
  (depth / complexity / alias limits), an operation allow list, and an introspection toggle.
  Its only runtime dependency is `graphql@16` — the engine speaks GraphQL-over-HTTP itself
  (`graphql-http` is not required). New CLI: `weave graphql:schema` emits the SDL offline. **Off by
  default** (`adapters.graphql.enabled`).
- **Named enums (schema v6).** Declare an enum once in `enums/<name>.json` and reference it from any
  field with `{ "type": "enum", "enumType": "<name>" }`. Values validate centrally, generate named
  TypeScript unions (`weave types`), surface as shared OpenAPI `components.schemas` (with
  `x-enumLabels`), and are listed with `weave enum:list` / `weave enum:check`; `weave field:add
  --enum` wires a new field to an existing enum. The on-disk format is bumped to **v6**
  (`SCHEMA_FORMAT_VERSION`); existing v5 files migrate on read (additive — run `weave schema:upgrade`
  to stamp them).

### Changed

- **Uncategorized `SchemaError`s now map to HTTP 400** instead of falling through to 500. The error
  space is dominated by request conditions (bad params/fields, RBAC, not-found); genuine server
  faults keep 500 via an explicit set (`http.internal`, `data.schemaDrift`, and script runtime
  failures `script.timeout` / `script.busy` / `script.compile` / `script.sandbox.unavailable`).

### Fixed

- **MCP session ↔ agent binding.** A follow-up request on an existing session now re-verifies that
  the presented Bearer key is the one that established the session (compared by a non-secret SHA-256
  fingerprint); a different key reusing a session id is rejected with `mcp.session.agentMismatch`.
  The raw API key is no longer stored on the session or written to the audit log — audit `actorId`
  is the credential fingerprint and the agent principal id stays in `meta`.

## [0.7.0]

### Added

- **Node 22 support.** The engine, CLI and scaffolded projects now run on Node **22+** (verified on
  Node 22 and Node 24). `engines.node` is `>=22`; generated projects declare the same.

### Changed

- `isolated-vm` — the optional native dependency behind the script sandbox — is pinned to
  **`^6.2.0`**, which ships prebuilt binaries for both Node 22 and Node 24 (7.x drops Node 22).
  Behavior is unchanged (the sandbox, RPC bridge and timeout/`__done` handling are covered by the
  same tests on both runtimes). Note: prebuilds are no longer published for Node 26 — on that
  runtime the script sandbox may fall back to a source build.

## [0.6.0]

A breaking release. The data model, access control and workflow were reworked end to end. Read the
**Breaking** section before upgrading.

### Breaking

- **Record ids are the `record_key`.** A record's external id is now a single URL-safe string that
  encodes the (possibly composite) primary key, surfaced as the read-only `weave_id` field. REST
  `/{id}`, MCP `id` and batch `ids[]` all take this string — read it from a result or `describe_object`
  instead of composing the raw primary key.
- **Field types are bucketed** into PG-native value types and engine-shipped custom types. `person`
  was renamed to `user`; `SCALAR` was removed; `currency` accepts an optional ISO 4217 code (and an
  optional `precision`); `json` now maps to PostgreSQL `json` — use `jsonb` for the old behavior. Run
  `weave schema:upgrade`.
- **Row scopes add `department`** (`own | department | all`) plus a separate `manage` scope for writes,
  and a scope column's ids can be `internal` (engine ids) or `external` (customer ids).
- **Identity directory** — the engine now owns `weavekit_user` / `weavekit_department`; sync an external
  source with `weave sync:identity`, authenticate through a verifier, and manage users over the admin
  REST surface.
- **`multiRelation` uses a link table** (real FK per side, `ON DELETE CASCADE`) instead of a column;
  reads and filters are scoped to the targets the subject can read.
- **Workflow rewritten to a single-line node chain** (`workflow.json` format v2). v1 state-machine
  files are linearized on read. Instance/step/workitem state lives in engine tables
  (`weavekit_workflow_instances` / `_steps` / `_workitems`, plus locks/definitions/timers). New
  REST + MCP surface; `weave workflow:migrate` was **removed**; the side-table column
  `workflow_id` was renamed to `workflow_instance_id`; `weave migrate` drops and recreates the timer
  table.
- **Engine-owned system tables + runtime zero-DDL.** All DDL is emitted by `weave migrate`; the runtime
  never alters or drops customer columns (reads only).
- **Security hardening** — formula references respect RBAC, `details` children inherit (and can only
  narrow) their parent's permissions, DDL literals are escaped, and script SQL is gated by an AST pass.

### Added

- Record-metadata side tables with `weave_*` virtual fields (`weave_id`, `weave_status`,
  `weave_owner_id`, `weave_created_by`/`_modified_by`, `weave_created_time`/`_modified_time`,
  `weave_workflow_instance_id`) — request them in `fields`, and they work in `filter` / `sort`.
- Field types: native PG enums for static `enum`s, data-driven `enum` options, `seq_no`, `uuid`,
  `smallint`/`bigint`/`real`/`double`/`char`, numeric `precision`/`scale`, `json`/`jsonb`.
- Reverse-modeling: `weave introspect` handles composite primary keys and native enum/array columns;
  `weave schema:map` reports schema↔column drift.
- Workflow actions `submit` / `approve` / `reject` / `forward` / `withdraw` / `cancel` / `reactivate`,
  any-one / all approvals, node timeouts, an admin override, and definition write-back.
- `describe_object` exposes a field's resolved type `base`.

### Changed

- `weave migrate` registers content-addressed workflow definitions; instances pin the hash they started
  under, so editing `workflow.json` only affects new records.
- Live `record.transitioned` events carry `from` / `to` / `action`.

### Fixed

- Correct row-scope parameter offset on `update` / `delete` / `transition`.
- `record_key` encoding is single-sourced in SQL (contract-tested).

# Changelog

All notable changes to `@weave-kit/engine`. Format follows [Keep a Changelog](https://keepachangelog.com/);
the project uses [Semantic Versioning](https://semver.org/).

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

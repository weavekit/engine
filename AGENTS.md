# @weave-kit/engine — architecture notes

This file is the entry point for contributors and coding agents: the invariants that are easy to
break. User-facing docs live in [`docs/`](docs/README.md); deeper rationale is in code comments.

Runtime/build constraints: Node 22+; ESM (`"type": "module"`); build `tsc`→`dist`; Conventional
Commits.

## Positioning (hard constraint)

Open metadata-driven headless engine. The only input is `schema.json`; the output is PostgreSQL
tables + REST / GraphQL APIs + MCP tools + RBAC + TypeScript types. **Zero business
dependencies, zero UI output** — it emits no UI components and renders no DOM, and the schema
contains no UI attributes (widgets/radio buttons/dropdowns are the frontend's concern).

## Architecture constraints (dependency DAG, eslint-enforced)

- Dependency direction: `core/` ← `subsystems/` ← `adapters/`; `subsystems/` do not import each
  other; `infrastructure/` depends only on core contracts; `adapters/` may import `core/` but not
  `subsystems/`
- The engine **does not import `@weave-kit/client`** (client is a consumer, the opposite direction)
- Server-side scripts may access data only through the controlled `context` API; no direct
  database/network access from scripts
- `core/` never imports `subsystems/` or anything adapter-specific

## Directory structure (current)

```
src/
├─ core/            Always compiled (contracts + pure logic): types/object/formula/i18n/storage/
│                   api/rbac/audit/script/provider/tools/proxy/limiter
├─ subsystems/      Optional, lazily loaded (disabled = not imported = zero overhead):
│                   approvals/audit/evidence/quota/script/workflow
├─ infrastructure/  Pluggable providers (alerts/event); depends only on core contracts
├─ adapters/        Protocol bindings: rest/auth/ops/mcp/graphql/openapi (+ events SSE; ingress is a rest route)
├─ runtime/         Mechanism: data-access/enums/execution/fieldtypes/git/identity/metadata/
│                   record-meta/sql-analyzer/tools/proxy/tunnel
├─ cli/             The `weave` command
├─ index.ts         createEngine(config) assembly; values.ts / layout-format.ts / experimental.ts
└─ version.ts       Version single source of truth
tests/              unit + e2e (node --test)
```

## Key implementation conventions (high-frequency invariants)

- Subsystems load dynamically: `if (config.subsystems?.x?.enabled) { await import(...) }`
- Sandbox script hooks receive context via `this` (`record/changes/records/user/db/services`), with
  no parameters; the sandbox backend is a worker + `isolated-vm`, hidden behind the pluggable
  `SandboxBackend` interface (`isolated-vm` is an optional dependency)
- Data-access layers: object query (automatic RLS + RBAC) and restricted SQL (SELECT-only +
  parameterized + LIMIT + timeout)
- Public surface is tiered: `.` (stable), `./experimental` (unstable internals), `./values` +
  `./layout` (browser-safe, zero runtime imports); the `exports` map blocks unlisted subpaths.
- Enums are always `as const` single sources of truth, with types derived via
  `typeof x[keyof typeof x]`; never a second hardcoded literal union
- **Multi-tenancy (row)**: a `"tenant": true` field scopes reads/writes to the subject tenant (RBAC
  row scope + RLS GUC `weavekit.tenant_id` + audit); forced on create, immutable on update; absent
  tenant = single-tenant. Tenant lifecycle / schema-per-tenant are enterprise (out of engine scope)
- **Execution**: `runtime/execution` `runPipeline` drives writes (gate `object.<obj>.<op>`) and tool
  calls (Plan→…→Evidence); `evidence.enabled` records `weavekit_evidence`. `CONTRACT_VERSION` freezes
  the public contract — post-1.0 evolution is additive only

## Schema relation model (summary)

No `relations` array (relations live in `fields`: `relation`/`details`/`multiRelation`); composite
scalar primary keys; PG-native + registrable custom field types (`config.fieldTypes` + project
`field-types/`, fail-closed); `user`/`department` identity FKs; capability gating = `features.fieldTypes`.
Full model → [`docs/…/03-model/02-schema`](docs/01-guides/03-model/02-schema/01-overview.md).

## Product contract (weave command principles)

All in-project operations go through `weave` (bypassing it disables schema validation, auto-commit
and the sandbox); `--type` is a starting preset that **never trims core**; capability gating only via
config switches — splitting core by type, or letting the validator open holes by type, is forbidden.

## Subsystem status

Core: types/object/formula/i18n/storage ✅ · Data access + RBAC (row & field) ✅ · Identity + sync ✅ ·
Workflow ✅ · REST + auth + ops + metadata ✅ · GraphQL adapter ✅ · Git metadata + cache ✅ · CLI ✅ ·
Audit (log/modes/outbox) ✅ · Script sandbox ✅ · MCP adapter ✅ · OpenAPI 3.1 ✅ ·
Tools + guardrails + approvals ✅ · SSE ✅ · Proxy ✅ · Quotas ✅ · Ingress ✅ · Tunnel ✅ ·
Named enums (schema v6) ✅ · Schema revision + `weave deploy` ✅ · QueryBudget ✅ ·
Agent Execution + Evidence ✅ · Multi-tenancy (row) ✅ · Contract freeze ✅ ·
Observability seam (metrics/trace) ✅

## Maintenance rules

- `pages:*` and the `./layout` export are UI-related pre-release surfaces: kept out of public
  `docs/` and the generated OpenAPI on purpose (not hidden from the API).
- Keep this file to invariants only; put narrative detail in `docs/` and code comments
- Every metadata change is auto-committed to Git by the engine; the `objects/` tree is the schema
  source of truth
- The package version must match `src/version.ts` (the scaffolder injects it into generated projects)

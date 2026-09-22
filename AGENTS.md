# @weave-kit/engine — architecture notes

This file is the entry point for contributors and coding agents: the invariants that are easy to
break. User-facing documentation lives in [`docs/`](docs/README.md); deeper
implementation rationale is captured in code comments and `docs/`.

Runtime/build constraints: Node 24 LTS; ESM (`"type": "module"`); build `tsc`→`dist`; Conventional
Commits.

## Positioning (hard constraint)

Open metadata-driven headless engine. The only input is `schema.json`; the output is PostgreSQL
tables + REST API + RBAC + MCP tools + TypeScript types. **Zero business
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
├─ subsystems/      Optional, lazily loaded (disabled = not imported = zero overhead): audit/script
├─ infrastructure/  Pluggable providers (identity/alerts/event); depends only on core contracts
├─ adapters/        Protocol bindings: rest/auth/ops/mcp/openapi (+ events, ingress)
├─ runtime/         Mechanism: data-access/git/metadata/tools/proxy/tunnel
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
- The public surface is tiered: the stable `.` barrel, `./experimental` (unstable internals),
  `./values` and `./layout` (browser-safe, zero runtime imports). The `exports` map blocks unlisted
  subpaths — see [`docs/reference/public-api.md`](docs/reference/public-api.md)
- Enums are always `as const` single sources of truth, with types derived via
  `typeof x[keyof typeof x]`; never a second hardcoded literal union

## Schema relation model (summary)

**No `relations` array** — relations all live in `fields`: `relation` (weak reference / FK),
`details` (strong 1:N ownership), `multiRelation` (multi-select reference). A primary key is scalar
only and unique. Field types have two layers — primitive + semantic — with a single source of truth
in `core/types/registry.ts`. Trees/TOC use a self-referencing `relation`. Capability gating is
declarative via config (`features.fieldTypes`, fail-closed). The schema contains **no UI attributes**.

## Product contract (weave command principles)

All in-project operations go through the `weave` command (`weave dev/build/test/migrate`); bypassing
the entry point disables schema validation, auto-commit and the sandbox. `--type` is a starting
preset (subsystem combination + narrative) and **never trims core**. Capability gating only goes
through config switches; splitting core by type, or letting the validator open holes by type, is
forbidden.

## Subsystem status

| Subsystem | Status |
| --- | --- |
| Metadata core (types/object), i18n, formula, storage/migration | ✅ |
| Data access, RBAC (row + field level) | ✅ |
| REST API + auth + ops, frontend metadata contract | ✅ |
| Git-backed metadata + metadata cache | ✅ |
| CLI `weave` + config + type generation | ✅ |
| Audit subsystem (immutable event log) | ✅ |
| Script subsystem (worker + isolated-vm sandbox) | ✅ |
| MCP adapter (streamable HTTP, per-identity tool surface) | ✅ |
| OpenAPI 3.1 generator (`buildOpenApiDocument`, `weave openapi`) | ✅ |
| Custom tools, guardrail policies, audit replay | ✅ |
| Live channel (SSE + replay) | ✅ |
| Engine generic Proxy | ✅ |
| Quotas / budgets (CounterStore + PG counters) | ✅ |
| Approvals queue (human-in-the-loop; requires the tool executor) | ✅ |
| External event ingress | ✅ |
| Tunnel transport primitive | ✅ |

## Maintenance rules

- `pages:*` (page layouts / scripts) and the `./layout` export are UI-related and pre-release:
  they stay out of the public `docs/` and the generated OpenAPI on purpose (not hidden from the API),
  and are noted at their CLI registration.
- Keep this file to invariants only; put narrative detail in `docs/` and code comments
- Every metadata change is auto-committed to Git by the engine; the `objects/` tree is the schema
  source of truth
- Runtime/build constraints: Node 24 LTS; `tsc`→`dist`; ESM (`"type": "module"`); the package
  version must match `src/version.ts` (the scaffolder injects this into generated projects)

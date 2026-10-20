/**
 * Engine assembly configuration types — extracted from `engine.ts` (2.1
 * maintainability). The runtime assembly and start-up guards live in
 * `engine.ts` / `guards.ts`; these are pure declarations (no runtime imports).
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type {
  ApprovalDelegationResolver,
  ApprovalEventSink,
  ApprovalsBackend,
  AuditMode,
  AuditSink,
  CounterStore,
  EngineScriptConfig,
  EngineWorkflowConfig,
  EventPublisher,
  EvidenceSink,
  FieldTypeRegistration,
  GuardrailPolicy,
  Locale,
  MetricsSink,
  ObjectRegistry,
  ProxyTargetResolver,
  ScriptDispatcher,
  ToolDefinition,
  TraceSink,
} from '../core/index.js';
import type { IngressConfig } from '../core/provider/event/index.js';
import type { CapabilitiesProvider } from '../core/provider/capabilities/index.js';
import type { IdentitySource, IdentityStore } from '../core/provider/identity/index.js';
import type { PgIdentitySourceConfig } from './identity/sources/pg.js';
import type { ObjectDataAccess, QueryBudget, TotalMode } from './data-access/index.js';
import type { ProxyForwarder } from './proxy/index.js';
import type { AuthSource, AuthVerifier, Authenticator, OidcConfig } from '../adapters/auth/index.js';
import type { EngineMcpConfig, McpServerHandle } from '../adapters/mcp/index.js';
import type { EngineGraphQLConfig, GraphQLServerHandle } from '../adapters/graphql/index.js';
import type { PrincipalResolver } from '../adapters/rest/index.js';
import type { ProjectType } from '../cli/types/index.js';
import type { ApprovalsQueue, ToolExecutor } from './tools/index.js';
import type { AuditEngine } from '../subsystems/audit/index.js';
import type { WorkflowTimerScheduler } from '../subsystems/workflow/index.js';

/** REST interface configuration */
export interface EngineRestConfig {
  enabled?: boolean;
  /** URL prefix for object routes; defaults to `/api` */
  prefix?: string;
  /** per-agent-key sliding-window rate limiting; disabled when absent */
  rateLimit?: { windowMs?: number; max?: number };
  /** CORS settings (passed to @fastify/cors); disabled when absent */
  cors?: {
    origin?: string | string[] | boolean;
    methods?: string[];
    allowedHeaders?: string[];
    maxAge?: number;
  };
  /** maximum request body size in bytes; defaults to 1 MiB */
  bodyLimit?: number;
  /** roles allowed to query the full audit trail and use admin script-source read/write routes */
  adminRoles?: string[];
  /**
   * maps an authenticated request to the data-access principal (see
   * `PrincipalResolver`). A control plane injects this to run requests under a
   * **system/admin scope** (cross-tenant global views, D32); absent = `userPrincipal`.
   */
  principalFor?: PrincipalResolver;
}

/** audit subsystem config (optional; disabled = not loaded = zero overhead) */
export interface EngineAuditConfig {
  enabled?: boolean;
  /**
   * Durability mode (default `best-effort`): `best-effort` = fire-and-forget
   * process buffer; `transactional` = audit row written in the business
   * transaction; `durable` = transactional outbox + relay (crash-safe,
   * at-least-once).
   */
  mode?: AuditMode;
  /**
   * Accept a best-effort fallback when `mode` is `transactional`/`durable` but
   * the resolved sink cannot write in-transaction (`recordInTx`). Default
   * `false` = fail-closed at startup (a misconfigured sink would otherwise drop
   * events on crash). Built-in sinks always satisfy the requirement.
   */
  allowBestEffortFallback?: boolean;
  /** audit diff replay: attach before/after row snapshots to update/delete audit events (default off; table always has the columns) */
  replay?: boolean;
  /** L1 buffered-sink parameters */
  batch?: { batchSize?: number; flushMs?: number };
  /**
   * Replace the built-in audit sink (enterprise E2: export/retention/WORM). The
   * provided sink replaces the mode-built inner sink; the durability guard
   * (`assertAuditSinkCapability`) and the events dual-emit wrapper still apply.
   */
  sink?: AuditSink;
  /**
   * Wrap the mode-built inner sink (tee) — e.g. enterprise E2 mirroring every
   * event to an export target while the engine still persists it. Applied before
   * the events dual-emit wrapper; the wrapper must preserve `recordInTx` to keep
   * `transactional`/`durable` durability.
   */
  wrap?: (inner: AuditSink) => AuditSink;
}

/**
 * Engine-level tool mechanism config (open contract, protocol-agnostic —
 * lives at the top level, not under `adapters.*`). Disabled when absent.
 */
export interface EngineToolsConfig {
  /** custom tool directory (relative to schemaDir, like `objects/`); default `tools` */
  toolsDir?: string;
  /** guardrail policies: inline array or a policies directory path (loaded by the assembly layer) */
  guardrails?: {
    policies?: GuardrailPolicy[] | string;
  };
  /**
   * approval queue persistence (release-grade). Absent → PG-backed when the
   * tool executor is created; `backend: 'memory'` opts into the single-process
   * in-memory queue (tests). No Redis backend is implemented.
   */
  approvals?: {
    backend?: 'pg' | 'memory' | ApprovalsBackend;
    /** approval TTL in ms (default 72h; legacy rows without expiresAt never expire) */
    ttlMs?: number;
    /** optional lifecycle sink (enterprise notifications / audit fan-out) */
    events?: ApprovalEventSink;
    /** optional delegation resolver (delegate subject -> original approver) */
    delegation?: ApprovalDelegationResolver;
  };
}

/** live event channel config (optional; disabled = not created = zero overhead) */
export interface EngineEventsConfig {
  enabled?: boolean;
  /** URL prefix for the SSE endpoint; defaults to `/api` */
  prefix?: string;
  /** roles allowed to see every actor's audit events (mirrors adapters.rest.adminRoles) */
  adminRoles?: string[];
  /** replay ring buffer size + heartbeat tuning */
  replay?: { maxEvents?: number; heartbeatMs?: number };
}

/**
 * Generic engine proxy. Configured with `proxy.resolver`
 * only → otherwise (absent) the proxy is not wired (zero overhead). The engine
 * provides the mechanism (contract + forwarder + routes); the resolver carries
 * the application semantics (which connection a subject may reach).
 */
export interface EngineProxyConfig {
  /** inject application layer: resolve connection → target (id/url/key/keyScope). */
  resolver?: ProxyTargetResolver | ProxyTargetResolverBuilder;
  /** injectable fetch (tests / custom transport). */
  fetchImpl?: typeof fetch;
  /**
   * custom outbound forwarder, e.g. a tunnel-aware one that routes
   * `transport: 'tunnel'` targets over a live connector. Builder form receives
   * the runtime deps so the host can read its own metadata. Default = fetch.
   */
  forwarder?: ProxyForwarder | ((deps: ProxyResolverDeps) => ProxyForwarder);
  enabled?: boolean;
}

/** runtime deps handed to a {@link ProxyTargetResolverBuilder} so the app can read its own metadata. */
export interface ProxyResolverDeps {
  dataAccess: ObjectDataAccess;
  pool: Pool;
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
}

/**
 * Factory form of `resolver`: built by the engine at assembly time with the real
 * runtime deps, so the app can read its metadata (e.g. the governance engine's
 * own `connections` object) server-side without a second pool. A plain
 * `ProxyTargetResolver` instance is also accepted.
 */
export type ProxyTargetResolverBuilder = (deps: ProxyResolverDeps) => ProxyTargetResolver;

/** engine assembly configuration — the single wiring point (see AGENTS.md) */
/** a host-level background service returned by a service's `start`. */
export interface EngineServiceHandle {
  /** tear the service down (abort streams, clear timers); called on engine close. */
  stop(): Promise<void>;
}

/** host-app service factory the engine starts once assembled, stops on close. */
export interface EngineService {
  name: string;
  start(engine: WeaveKitEngine): Promise<EngineServiceHandle> | EngineServiceHandle;
}

/** identity directory wiring (see `core/provider/identity`) */
export interface EngineIdentityConfig {
  /**
   * provisioning source: an `IdentitySource` instance (has `pull`) or a
   * declarative `PgIdentitySourceConfig`. Absent → greenfield (the engine owns
   * `weavekit_user`/`weavekit_department` directly).
   */
  source?: IdentitySource | PgIdentitySourceConfig;
  /** replaceable local directory store; defaults to PG over `weavekit_*` */
  store?: IdentityStore;
  /**
   * credential verifier (OIDC/JWT/SAML); when set the engine authenticates via
   * `verifier → directory → subject` and `auth.source` may be omitted.
   */
  verifier?: AuthVerifier;
  /** reject subjects with no local identity for scoped access (default false) */
  required?: boolean;
  sync?: {
    /** run the source sync on engine start (fail-closed) */
    onStart?: boolean;
    /** soft-disable local rows absent from the source snapshot */
    deactivateMissing?: boolean;
  };
}

export interface EngineConfig {
  /** postgres connection string; defaults to process.env.DATABASE_URL */
  databaseUrl?: string;
  /**
   * connection string used only for schema migration/DDL by the CLI (`weave
   * migrate`/`weave dev`). Defaults to `databaseUrl`. **Same database, a
   * separate account** — a PostgreSQL role with DDL rights (usually the owner),
   * so the runtime account can be least-privileged (no DDL/DROP/TRUNCATE).
   * Pointing it at a *different* database is a misconfiguration (migrations
   * would land where the runtime cannot see them). The engine itself never runs
   * DDL at runtime.
   */
  migrationDatabaseUrl?: string;
  /**
   * runtime database account guard. The engine only ever runs DML, so its
   * account should be least-privileged (no schema `CREATE`); DDL is an explicit
   * `weave migrate` using `migrationDatabaseUrl`. When `requireRestrictedAccount`
   * is true (the default) the engine **fails to start** if its account can
   * create objects in the current schema. Set false for a single-account setup
   * (`weave dev` does this by default), or override with the
   * `WEAVEKIT_REQUIRE_RESTRICTED_ACCOUNT` env var.
   */
  runtime?: { requireRestrictedAccount?: boolean };
  /** runtime message locale; resolution: config → env WEAVEKIT_LOCALE → 'en' */
  locale?: Locale;
  /**
   * project starting preset (agent/governance/service/business) — persisted by
   * the scaffolder. Used as CLI context (e.g. `weave object:create` scaffolds a
   * `client.js` template only for `business` projects). Not required at runtime.
   */
  projectType?: ProjectType;
  /**
   * project root whose `objects/<name>/schema.json` files are the metadata source.
   * The engine loads the schema on startup; it never touches the database unless
   * `migrate.auto` is true (default false — DDL is an explicit `weave migrate`).
   */
  schemaDir?: string;
  /**
   * migration behavior:
   * - `auto` — run the schema→PG migration (CREATE/ALTER) on engine startup.
   *   Default false: WeaveKit is a headless bridge to your database — building/
   *   altering tables is an explicit `weave migrate`. Enable for greenfield/
   *   business projects that want the schema to drive DDL automatically.
   *   Additive DDL on existing tables is governed per object by
   *   `schema.alter: true`.
   */
  migrate?: { auto?: boolean };
  /**
   * git behavior for engine startup syncs:
   * - `meta` — git-commit the metadata tree (`objects/`) after a `migrate.auto` sync
   * - `identity` — commit identity; falls back to a local weavekit identity
   */
  commit?: { meta?: boolean; identity?: { name: string; email: string } };
  /**
   * Authentication: a static key map / custom resolver (`source`), a built-in
   * OIDC/JWT verifier (`oidc`), or `identity.verifier` for a custom protocol
   * verifier. At least one is required. `oidc` requires a resolvable identity
   * directory (run `weave sync:identity`).
   */
  auth?: { source?: AuthSource; oidc?: OidcConfig };
  /** protocol adapters (REST/MCP/events/GraphQL), closable via config */
  adapters?: { rest?: EngineRestConfig; mcp?: EngineMcpConfig; events?: EngineEventsConfig; graphql?: EngineGraphQLConfig };
  /** engine-level tool mechanism: custom tools + guardrail policies; disabled when absent */
  tools?: EngineToolsConfig;
  /** optional subsystems, dynamically loaded when enabled (audit/script; workflow is declaration-driven; unknown keys error out) */
  subsystems?: { audit?: EngineAuditConfig; script?: EngineScriptConfig; workflow?: EngineWorkflowConfig };
  /**
   * durable fixed-period counters / usage budgets (optional; disabled when
   * absent). Backed by PostgreSQL (`weavekit_counters`) and exposed as
   * `engine.quotas`; the host consumes it around its own integration calls via
   * `core/limiter` `consumeQuota` / `assertQuota`.
   */
  quotas?: { backend?: 'pg'; store?: CounterStore };
  /**
   * Agent-native query budget: caps rows/filters/sorts (data-access), joins /
   * SQL length / statement timeout (restricted SQL) and GraphQL depth. Absent =
   * defaults (see `QUERY_BUDGET_DEFAULTS`).
   */
  queryBudget?: Partial<QueryBudget>;
  /**
   * List-query defaults for every read surface (REST / GraphQL / MCP).
   * `query.total` selects how a page's `total` is computed: `exact` (default,
   * `COUNT(*)`), `estimate` (`pg_class.reltuples` — approximate, cheap on large
   * tables) or `none` (skip counting; `total` omitted). A per-request `total`
   * argument overrides this.
   */
  query?: { total?: TotalMode };
  /**
   * Dedicated schema for the engine's own tables (`weavekit_*` system tables,
   * `weavekit_record__<object>` side tables, `weavekit_m2m__*` link tables), so
   * a DBA reviewing the customer schema does not see engine plumbing. Default
   * (absent) keeps them in the object schema (legacy). Set the same value on
   * `weave migrate`; the runtime appends it to `search_path`. Only affects new
   * databases (existing installs need a manual `ALTER TABLE … SET SCHEMA`).
   */
  systemSchema?: string;
  /**
   * Object-path row-level security (defense in depth; default off in 1.x).
   * With `enforce`, the engine runs user-principal customer-table reads /
   * updates / deletes under `role` (default `weavekit_object`), so PostgreSQL
   * policies generated from the same permission matrix re-check the RBAC row
   * scope. `weave migrate` provisions the role/policies; the engine refuses to
   * start when they are missing. Inserts and system principals run as the owner.
   */
  rls?: { enforce?: boolean; role?: string };
  /**
   * Execution evidence capture (optional; disabled when absent). When enabled,
   * every data-access write / workflow transition / tool call records one
   * `weavekit_evidence` row with its full stage timeline and real outcome
   * (best-effort: a failed evidence write never blocks the execution). Capture
   * only — export/retention belong to the enterprise E2 layer.
   */
  evidence?: { enabled?: boolean; sink?: EvidenceSink };
  /**
   * Row-scope / multi-tenancy (row mode). When enabled, a subject without a
   * scope is stamped with `defaultScope`, and objects declaring a `scope` field
   * are scoped to the subject's scope (RBAC row scope + RLS GUC + audit). Absent
   * = single-scope (unchanged). Lifecycle / schema-per-tenant are out of scope
   * (enterprise).
   */
  scope?: { enabled?: boolean; defaultScope?: string };
  /** generic outbound proxy route wiring (applications provide the resolver) */
  proxy?: EngineProxyConfig;
  /**
   * inbound external-event entry point (first-class ingress seam; disabled when
   * absent). The app provides provider verification + handling; the engine
   * preserves the raw body, rate-limits per source and audits the receipt.
   */
  ingress?: IngressConfig;
  /**
   * low-level observability sinks (optional; absent = no-op = zero overhead).
   * The engine emits request latency/status, RBAC denials, query-budget rejects
   * and finished spans; a host injects the telemetry backend. Labels must stay
   * low-cardinality and PII-free (see `core/observability`).
   */
  observability?: { metrics?: MetricsSink; trace?: TraceSink };
  /**
   * capability feature switches (declarative gating). `features.fieldTypes` is
   * a whitelist of field types a schema may declare; a field outside the list is
   * rejected by the validator (fail-closed). Defaults to the engine primitives
   * plus every semantic type (no gating) unless a project narrows it.
   */
  features?: { fieldTypes?: string[] };
  /**
   * project-local field-type registrations (open registration): a directory of
   * modules (each default-exporting a `FieldTypeRegistration` or array) and/or
   * inline entries. Compiled with the built-ins into an immutable effective
   * registry passed through validation + consumers (no mutable global).
   */
  fieldTypes?: { dir?: string; entries?: FieldTypeRegistration[] };
  /**
   * engine-owned identity directory (see `core/provider/identity`). `source`
   * imports an external user/department directory (a `pg` descriptor or an
   * `IdentitySource`); `weave sync:identity` provisions it into `weavekit_user`
   * / `weavekit_department` before the engine serves scoped access.
   */
  identity?: EngineIdentityConfig;
  /**
   * capabilities (feature/entitlement) read-only seam (see
   * `core/provider/capabilities`). The engine **never judges licensing** — a host
   * (e.g. `@weave-kit/enterprise` E0) injects a `CapabilitiesProvider`; absent =
   * baseline (no features). Surfaced at `GET {prefix}/capabilities`.
   */
  capabilities?: { provider?: CapabilitiesProvider };
  /**
   * host-level background services (e.g. an instance-liveness monitor). Started
   * after the engine is assembled and stopped in `close()`, so both `weave dev`
   * and production `main.ts` manage them identically. A service gets the whole
   * engine (data-access/pool/events) to orchestrate app-specific work.
   */
  services?: EngineService[];
}

/** a running engine: fastify app + pool + RBAC-decorated data access */
export interface WeaveKitEngine {
  app: FastifyInstance;
  registry: ObjectRegistry;
  pool: Pool;
  dataAccess: ObjectDataAccess;
  authenticator: Authenticator;
  /** MCP adapter handle (present unless adapters.mcp.enabled is false) */
  mcp?: McpServerHandle;
  /** GraphQL adapter handle (present when adapters.graphql.enabled is true) */
  graphql?: GraphQLServerHandle;
  /** tool mechanism (present when config.tools.toolsDir is set): executor + approval queue */
  tools?: { defs: ToolDefinition[]; executor: ToolExecutor };
  /** live event publisher (present when adapters.events.enabled): emits committed writes / audit / schema changes */
  events?: EventPublisher;
  /** generic proxy handle (present when config.proxy.resolver is set): forwarder + resolver */
  proxy?: { forwarder: ProxyForwarder; resolver: ProxyTargetResolver };
  /** audit subsystem (present when enabled); buffered sink is flushed on close */
  audit?: AuditEngine;
  /** durable counter store (present when `config.quotas` is set): quota/budget primitive */
  quotas?: CounterStore;
  /** script subsystem (present when enabled); workers are terminated on close */
  script?: ScriptDispatcher;
  /** approval queue (present when config.tools is set): shared by tools and workflow transitions */
  approvals?: ApprovalsQueue;
  /** workflow timer scheduler (present when `subsystems.workflow.enabled`): fires `onTimeout` */
  workflow?: WorkflowTimerScheduler;
  /** observability sinks (no-op unless `config.observability` injects one) */
  observability: { metrics: MetricsSink; trace: TraceSink };
  close(): Promise<void>;
}


import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import { join } from 'node:path';
import {
  DEFAULT_LOCALE,
  NOOP_AUDIT_SINK,
  ObjectRegistry,
  SchemaError,
  SUPPORTED_LOCALES,
  createPool,
  createSlidingWindow,
  type AuditSink,
  type CounterStore,
  type EngineScriptConfig,
  type EngineWorkflowConfig,
  type EventPublisher,
  type FieldTypeRegistration,
  type GuardrailPolicy,
  type Locale,
  type ProxyTargetResolver,
  type RbacSubject,
  type ScriptDispatcher,
  type ToolDefinition,
} from '../core/index.js';
import type { ObjectDataAccess } from './data-access/index.js';
import { createDataAccess, withRbac } from './data-access/index.js';
import type { ProjectType } from '../cli/types/index.js';
import { createToolExecutor, loadToolsDir } from './tools/index.js';
import { createApprovals, type ApprovalsQueue } from './tools/index.js';
import { resolvePolicies } from './tools/policies.js';
import type { ToolExecutor } from './tools/index.js';
import type { ProxyForwarder } from './proxy/index.js';
import { buildAuthenticator, type AuthSource, type Authenticator } from '../adapters/auth/index.js';
import {
  registerAuditRoutes,
  registerApprovalsRoutes,
  registerMetadataRoutes,
  registerObjectRoutes,
  registerPagesRoutes,
  registerPermissionsRoutes,
  registerProxyRoutes,
  registerIngressRoutes,
  registerSchemaRoutes,
  registerGuardrailsRoutes,
  registerIdentitiesRoutes,
  registerWorkflowRoutes,
  setErrorHandlers,
  type RestOptions,
} from '../adapters/rest/index.js';
import { registerScriptRoutes } from '../adapters/rest/scripts.js';
import { registerEventsRoutes } from '../adapters/events/index.js';
import type { EventBus, IngressConfig } from '../core/provider/event/index.js';
import { registerOpsRoutes } from '../adapters/ops/index.js';
import { registerMcp, type EngineMcpConfig, type McpServerHandle } from '../adapters/mcp/index.js';
import { createAlerts } from '../infrastructure/index.js';
import type { AuditEngine } from '../subsystems/audit/index.js';
import { version } from '../version.js';

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
}

/** audit subsystem config (optional; disabled = not loaded = zero overhead) */
export interface EngineAuditConfig {
  enabled?: boolean;
  /** retention window placeholder (auto-cleanup is not implemented yet) */
  retention?: string;
  /** audit diff replay: attach before/after row snapshots to update/delete audit events (default off; table always has the columns) */
  replay?: boolean;
  /** L1 buffered-sink parameters */
  batch?: { batchSize?: number; flushMs?: number };
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
    backend?: 'pg' | 'memory';
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

export interface EngineConfig {
  /** postgres connection string; defaults to process.env.DATABASE_URL */
  databaseUrl?: string;
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
  /** authentication source (static key map or custom resolver); required (engine fails fast when absent) */
  auth: { source: AuthSource };
  /** protocol adapters (REST/MCP/events), closable via config */
  adapters?: { rest?: EngineRestConfig; mcp?: EngineMcpConfig; events?: EngineEventsConfig };
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
  quotas?: { backend?: 'pg' };
  /** generic outbound proxy route wiring (applications provide the resolver) */
  proxy?: EngineProxyConfig;
  /**
   * inbound external-event entry point (first-class ingress seam; disabled when
   * absent). The app provides provider verification + handling; the engine
   * preserves the raw body, rate-limits per source and audits the receipt.
   */
  ingress?: IngressConfig;
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
  close(): Promise<void>;
}

export function resolveLocale(configLocale: Locale | undefined): Locale {
  const resolved = configLocale ?? (process.env.WEAVEKIT_LOCALE as Locale | undefined) ?? DEFAULT_LOCALE;
  const supported = new Set<Locale>(SUPPORTED_LOCALES);
  return supported.has(resolved) ? resolved : DEFAULT_LOCALE;
}

/**
 * Assemble a running engine from an already-built registry (no schema loading).
 * This is the low-level assembly used by `createEngine` and by tests/dev that
 * already hold an `ObjectRegistry` — prefer `createEngine` for the normal path.
 */
export async function buildEngineFromRegistry(
  registry: ObjectRegistry,
  config: EngineConfig,
): Promise<WeaveKitEngine> {
  const locale = resolveLocale(config.locale);
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new SchemaError('engine.databaseUrl.missing', {}, locale);
  }
  if (config.auth === undefined || config.auth.source === undefined) {
    throw new SchemaError('auth.notConfigured', {}, locale);
  }

  const pool = createPool(databaseUrl);

  // optional durable counter store (quotas/budgets); absent = zero overhead
  let quotas: CounterStore | undefined;
  if (config.quotas !== undefined) {
    const { createPgCounterStore } = await import('../subsystems/quota/index.js');
    quotas = await createPgCounterStore(pool);
  }

  // optional subsystems — dynamically loaded when enabled (disabled = not imported = zero overhead)
  const subsystems = config.subsystems ?? {};
  const unimplemented = Object.keys(subsystems).filter(
    (k) => k !== 'audit' && k !== 'script' && k !== 'workflow',
  );
  if (unimplemented.length > 0) {
    throw new Error(`subsystem not implemented: ${unimplemented.join(', ')}`);
  }

  let audit: AuditEngine | undefined;
  let bufferedSink: (AuditSink & { flush(): Promise<void> }) | undefined;
  let auditSink: AuditSink = NOOP_AUDIT_SINK;
  if (subsystems.audit?.enabled) {
    const { createAudit, createBufferedAuditSink } = await import('../subsystems/audit/index.js');
    audit = await createAudit(pool);
    bufferedSink = createBufferedAuditSink(audit, subsystems.audit.batch);
    auditSink = bufferedSink;
  }

  // live channel: the event bus is created only when adapters.events is
  // enabled (absent = not imported = zero overhead). Its publisher is injected
  // into data-access (record.* on committed writes) and the audit sink
  // (audit.event dual-emit). schema.changed is exposed via `engine.events`.
  const eventsCfg = config.adapters?.events;
  let eventBus: EventBus | undefined;
  let eventPublisher: EventPublisher | undefined;
  if (eventsCfg?.enabled) {
    const { createEventBus, publisherOf } = await import('../infrastructure/event/index.js');
    eventBus = createEventBus({ maxEvents: eventsCfg.replay?.maxEvents });
    eventPublisher = publisherOf(eventBus);
    if (auditSink !== NOOP_AUDIT_SINK) {
      // decorate the buffered sink so audit events also stream to live
      // subscribers (PG persistence and live push stay decoupled)
      const inner = auditSink;
      auditSink = {
        record(event) {
          eventPublisher!.publishAudit(event);
          return inner.record(event);
        },
        recordBatch(events) {
          for (const event of events) eventPublisher!.publishAudit(event);
          if (inner.recordBatch !== undefined) return inner.recordBatch(events);
          return Promise.all(events.map((e) => inner.record(e))).then(() => {});
        },
      };
    }
  }

  // Guardrail policies + approval queue are shared by the tool open-contract and
  // by workflow transitions (a transition policy self-filters on `ctx.action`,
  // e.g. it must check `ctx.action.startsWith('workflow.transition.')`).
  let policies: GuardrailPolicy[] = [];
  let approvals: ApprovalsQueue | undefined;
  if (config.tools !== undefined) {
    policies = await resolvePolicies(config.tools.guardrails?.policies, config.schemaDir ?? '.');
    // persisted approvals by default (PG — the engine's mandated DB); opt out
    // with `approvals.backend: 'memory'`. The approval queue must be durable /
    // multi-instance consistent, so it is never left single-process in-memory
    // for a release engine.
    if (config.tools.approvals?.backend !== 'memory') {
      const { createApprovalsBackend } = await import('../subsystems/approvals/index.js');
      const backend = await createApprovalsBackend(pool);
      approvals = createApprovals({ audit: auditSink, backend });
    } else {
      approvals = createApprovals({ audit: auditSink });
    }
  }

  // The script subsystem needs a data-access to serve `this.db.objects` RPCs,
  // while the engine's exposed data-access needs the script dispatcher to fire
  // hooks. The cycle is resolved by giving the bridge its own RBAC-decorated
  // instance over the same base and adding the dispatcher to the exposed one.
  const replay = subsystems.audit?.replay === true;
  const baseDataAccess = createDataAccess({ audit: auditSink, replay, events: eventPublisher, policies, approvals });

  let script: ScriptDispatcher | undefined;
  let dataAccess: ObjectDataAccess;
  if (subsystems.script?.enabled) {
    const { createScriptDispatcher } = await import('../subsystems/script/index.js');
    const rbacDataAccess = withRbac(baseDataAccess, { audit: auditSink });
    script = await createScriptDispatcher({
      objectsDir: join(config.schemaDir ?? '.', 'objects'),
      registry,
      pool,
      dataAccess: rbacDataAccess,
      services: subsystems.script.services,
      config: subsystems.script,
      locale,
    });
    dataAccess = withRbac(createDataAccess({ audit: auditSink, script, replay, events: eventPublisher, policies, approvals }), { audit: auditSink });
  } else {
    dataAccess = withRbac(baseDataAccess, { audit: auditSink });
  }
  const authenticator = buildAuthenticator(config.auth);

  // tool mechanism: load custom tools when config.tools.toolsDir is set
  // (absent = not loaded = zero overhead). The executor wraps the RBAC-decorated
  // data-access; rate limiting stays at the adapter layer (per-agentKey), the
  // executor's `guardrails` handle is a no-op self-check for tool authors.
  let tools: { defs: ToolDefinition[]; executor: ToolExecutor } | undefined;
  if (config.tools?.toolsDir !== undefined) {
    const toolsDir = join(config.schemaDir ?? '.', config.tools.toolsDir);
    const loaded = await loadToolsDir(toolsDir, { locale });
    tools = {
      defs: loaded.map((l) => l.definition),
      executor: createToolExecutor({
        dataAccess,
        pool,
        registry,
        guardrails: { checkRateLimit: () => true },
        audit: auditSink,
        policies,
        locale,
        ...(approvals === undefined ? {} : { approvals }),
      }),
    };
  }

  const rest = config.adapters?.rest;
  const mcpCfg = config.adapters?.mcp;
  let proxyHandle: { forwarder: ProxyForwarder; resolver: ProxyTargetResolver } | undefined;
  const logLevel = (process.env.WEAVEKIT_LOG_LEVEL as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent') ?? 'info';
  // forceCloseConnections: on close, terminate lingering keep-alive/long-lived
  // connections (e.g. SSE /api/events) instead of letting `server.close()` wait
  // on them — otherwise hot reload (`weave dev`) hangs while a frontend is
  // subscribed to the live channel.
  const app = Fastify({ logger: { level: logLevel }, bodyLimit: rest?.bodyLimit ?? 1_048_576, forceCloseConnections: true });
  if (rest?.enabled ?? true) {
    setErrorHandlers(app, locale);
    const restOptions: RestOptions = { prefix: rest?.prefix };
    if (rest?.rateLimit !== undefined) {
      restOptions.rateLimiter = createSlidingWindow(rest.rateLimit);
    }
    restOptions.adminRoles = rest?.adminRoles;
    if (rest?.cors !== undefined) {
      // @fastify/cors defaults to GET,HEAD,POST — the engine's REST also uses
      // PATCH/DELETE, so default the allowed methods to the engine surface when
      // the caller didn't pin them (otherwise cross-origin PATCH preflights fail)
      await app.register(cors, {
        ...rest.cors,
        methods: rest.cors.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      });
    }
    registerObjectRoutes(
      app,
      {
        registry,
        pool,
        dataAccess,
        authenticator,
        locale,
        audit,
      },
      restOptions,
    );
    registerScriptRoutes(
      app,
      {
        registry,
        authenticator,
        locale,
        projectDir: config.schemaDir,
        commitIdentity: config.commit?.identity,
      },
      restOptions,
    );
    registerPagesRoutes(
      app,
      {
        registry,
        authenticator,
        locale,
        projectDir: config.schemaDir,
        commitIdentity: config.commit?.identity,
      },
      restOptions,
    );
    registerSchemaRoutes(
      app,
      {
        registry,
        authenticator,
        locale,
        projectDir: config.schemaDir,
        commitIdentity: config.commit?.identity,
      },
      restOptions,
    );
    // guardrail policy source (list/read/write, admin) — only when the
    // `tools.guardrails.policies` config is a directory path.
    const guardrailsPolicies = config.tools?.guardrails?.policies;
    registerGuardrailsRoutes(
      app,
      {
        authenticator,
        locale,
        projectDir: config.schemaDir,
        policiesDir: typeof guardrailsPolicies === 'string' ? guardrailsPolicies : undefined,
        commitIdentity: config.commit?.identity,
      },
      restOptions,
    );
    // identity directory (admin read) — only the static `mcp.identities` map
    // has an introspectable surface; a function resolver returns `[]`.
    registerIdentitiesRoutes(
      app,
      {
        authenticator,
        locale,
        identities: typeof mcpCfg?.identities === 'object' ? (mcpCfg.identities as Record<string, RbacSubject>) : undefined,
      },
      restOptions,
    );
    // frontend metadata contract (framework-agnostic, all frontend adapters consume these)
    registerMetadataRoutes(app, { registry, pool, dataAccess, authenticator, locale }, restOptions);
    registerPermissionsRoutes(app, { registry, pool, dataAccess, authenticator, locale }, restOptions);
    registerAuditRoutes(app, { registry, pool, dataAccess, authenticator, locale, audit }, restOptions);
    // approval queue routes (depth-1 read + local write): present when the
    // tool executor is enabled (toolsDir set) — `tools.executor.approvals`.
    registerApprovalsRoutes(
      app,
      { registry, pool, dataAccess, authenticator, locale, approvals },
      restOptions,
    );
    // workflow transitions — available for any object declaring objects/<name>/workflow.json
    registerWorkflowRoutes(app, { registry, pool, dataAccess, authenticator, locale }, restOptions);

    // Generic outbound proxy (P-4). Wired only when `config.proxy.resolver` is
    // provided (absent = createProxyForwarder is not imported = zero overhead).
    // The resolver carries the app semantics incl. which connection a subject
    // may reach; the engine only supplies the gateway (forwarder + routes).
    if (config.proxy?.resolver !== undefined) {
      const { createProxyForwarder } = await import('./proxy/index.js');
      // A host may inject a custom forwarder (e.g. a tunnel-aware one that routes
      // `transport: 'tunnel'` targets over a live connector). Builder form receives
      // the runtime deps so it can read its own metadata. Default = plain fetch forwarder.
      const forwarder =
        typeof config.proxy.forwarder === 'function'
          ? config.proxy.forwarder({ dataAccess, pool, registry, authenticator, locale })
          : config.proxy.forwarder ??
            createProxyForwarder({
              locale,
              ...(config.proxy.fetchImpl !== undefined ? { fetchImpl: config.proxy.fetchImpl } : {}),
            });
      const resolver =
        typeof config.proxy.resolver === 'function'
          ? config.proxy.resolver({ dataAccess, pool, registry, authenticator, locale })
          : config.proxy.resolver;
      registerProxyRoutes(
        app,
        {
          authenticator,
          locale,
          resolver,
          forwarder,
          audit: auditSink,
        },
        restOptions,
      );
      proxyHandle = { forwarder, resolver };
    }

    // Inbound external events (first-class ingress seam). Enabled only when
    // `config.ingress` is set (absent = no parser/routes = zero overhead); the
    // app's verifier is the auth gate (fail-closed), the engine audits receipts.
    if (config.ingress !== undefined) {
      registerIngressRoutes(
        app,
        {
          audit: auditSink,
          locale,
          ...(config.ingress.rateLimit !== undefined
            ? { rateLimiter: createSlidingWindow(config.ingress.rateLimit) }
            : {}),
        },
        config.ingress,
      );
    }
  }

  // live channel: SSE endpoint (Bearer auth, subject-filtered, replay)
  if (eventBus !== undefined && eventPublisher !== undefined) {
    registerEventsRoutes(
      app,
      {
        registry,
        authenticator,
        locale,
        bus: eventBus,
        adminRoles: eventsCfg?.adminRoles,
      },
      {
        prefix: eventsCfg?.prefix,
        heartbeatMs: eventsCfg?.replay?.heartbeatMs,
        corsOrigin: config.adapters?.rest?.cors?.origin,
      },
    );
  }

  // operational routes are registered unconditionally — liveness/readiness and
  // version must be reachable even when every adapter is disabled
  registerOpsRoutes(app, { pool, version });

  // MCP adapter: enabled by default (adapters.mcp undeclared = on). Sinks are
  // injected: audit (buffered subsystem sink or NOOP), alerts (createAlerts
  // factory — console default), identity (mcp.identities: static dir or a
  // customer-provided IdentityResolver).
  let mcp: McpServerHandle | undefined;
  if (mcpCfg?.enabled ?? true) {
    mcp = registerMcp(app, {
      engine: { registry, pool, dataAccess, locale },
      authenticator,
      mcp: mcpCfg,
      locale,
      audit: auditSink,
      alerts: createAlerts(mcpCfg?.guardrails?.alerts),
      tools,
      corsOrigin: config.adapters?.rest?.cors?.origin,
    });
  }

  // host services (started after assembly so they can use the whole engine;
  // stopped in `close()` before the app/pool teardown so their outbound streams
  // are released first)
  const serviceStops: Array<() => Promise<void>> = [];

  const engine: WeaveKitEngine = {
    app,
    registry,
    pool,
    dataAccess,
    authenticator,
    mcp,
    tools,
    events: eventPublisher,
    proxy: proxyHandle,
    audit,
    quotas,
    script,
    approvals,
    async close() {
      const warn = (phase: string, error: unknown): void => {
        console.error(`weavekit: ${phase} close error: ${error instanceof Error ? error.message : String(error)}`);
      };
      // Signal monitored instances (best-effort) and give the SSE write time to
      // flush before the socket is torn down below. Emitting here — rather than
      // in each entrypoint — covers `weave dev` and every production `main.ts`
      // (including pre-existing ones) identically.
      eventPublisher?.publishLifecycle('shutdown');
      await new Promise((resolve) => setTimeout(resolve, 60));
      for (const stop of serviceStops) await stop().catch((error) => warn('service stop', error));
      // Bounded graceful server close. The events adapter ends its SSE streams
      // in an onClose hook, so `app.close()` normally resolves promptly; this
      // race is the safety net — if any long-lived connection lingers, force
      // it closed after a grace period instead of hanging (hot reload / tests).
      try {
        const graceful = app.close().catch((error) => warn('server', error));
        const timeout = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            app.server.closeAllConnections?.();
            resolve();
          }, 3000);
          timer.unref?.();
        });
        await Promise.race([graceful, timeout]);
      } catch (error) {
        warn('server', error);
      }
      await mcp?.close().catch((error) => warn('mcp', error));
      await script?.close().catch((error) => warn('script', error));
      await bufferedSink?.flush().catch((error) => warn('audit flush', error));
      await audit?.close().catch((error) => warn('audit', error));
      eventBus?.close();
      await pool.end().catch((error) => warn('pool', error));
    },
  };

  for (const service of config.services ?? []) {
    try {
      const handle = await service.start(engine);
      serviceStops.push(() => handle.stop());
    } catch (error) {
      // a mid-start failure must not leave previously-started services running
      await Promise.all(
        serviceStops.splice(0).map((stop) =>
          stop().catch((e) => console.error(`weavekit: service stop error (${service.name}): ${e instanceof Error ? e.message : String(e)}`)),
        ),
      );
      throw error;
    }
  }

  return engine;
}

import Fastify from 'fastify';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  NOOP_AUDIT_SINK,
  NOOP_METRICS_SINK,
  NOOP_TRACE_SINK,
  METRIC_NAMES,
  ObjectRegistry,
  SchemaError,
  AUDIT_MODES,
  createPool,
  createSchemaScope,
  parseTraceparent,
  searchPathOptions,
  type AuditSink,
  type CounterStore,
  type EventPublisher,
  type GuardrailPolicy,
  type ScriptDispatcher,
  type ToolDefinition,
  type WorkflowTimerSync,
} from '../core/index.js';
import type { ObjectDataAccess } from './data-access/index.js';
import { createDataAccess, withRbac } from './data-access/index.js';
import { createToolExecutor, loadToolsDir } from './tools/index.js';
import { createApprovals, type ApprovalsQueue } from './tools/index.js';
import { resolvePolicies } from './tools/policies.js';
import type { ToolExecutor } from './tools/index.js';
import { buildAuthenticator, createDirectoryAuthenticator, createOidcVerifier, enforceSyncedIdentity, withDefaultScope, type Authenticator } from '../adapters/auth/index.js';
import { PgIdentityDirectory, PgIdentityStore, resolveIdentitySource, runIdentitySync } from './identity/index.js';
import { registerEventsRoutes } from '../adapters/events/index.js';
import type { EventBus } from '../core/provider/event/index.js';
import { registerOpsRoutes } from '../adapters/ops/index.js';
import { registerHttpRoutes } from './register-http-routes.js';
import { registerMcp, type McpServerHandle } from '../adapters/mcp/index.js';
import { registerGraphQL, type GraphQLServerHandle } from '../adapters/graphql/index.js';
import { createNotificationSink } from '../infrastructure/notifications/index.js';
import type { NotificationSinkConfig } from '../core/provider/notifications/index.js';
import type { AuditEngine } from '../subsystems/audit/index.js';
import type { EvidenceSink } from '../core/index.js';
import { resolveQueryBudget } from './data-access/index.js';
import type { WorkflowTimerScheduler } from '../subsystems/workflow/index.js';
import { version } from '../version.js';

import type { EngineConfig, WeaveKitEngine } from './config-types.js';
export type * from './config-types.js';
import {
  resolveLocale,
  resolveObjectRlsRole,
  assertObjectRlsProvisioned,
  assertRestrictedRuntimeAccount,
} from './guards.js';
export {
  resolveLocale,
  resolveRequireRestrictedAccount,
  resolveObjectRlsRole,
  assertObjectRlsProvisioned,
  assertRestrictedRuntimeAccount,
} from './guards.js';

interface LegacyAlertsConfig {
  channel?: 'console' | 'webhook' | 'slack';
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  webhookUrl?: string;
  slackChannel?: string;
  slackUsername?: string;
}

/** Map the deprecated `mcp.guardrails.alerts` shape onto a notification transport. */
function legacyAlertsConfig(alerts: LegacyAlertsConfig): NotificationSinkConfig {
  if (alerts.channel === 'webhook') {
    if (alerts.url === undefined) throw new Error('mcp.guardrails.alerts: webhook requires a url');
    return {
      channels: {
        webhook: {
          url: alerts.url,
          ...(alerts.headers === undefined ? {} : { headers: alerts.headers }),
          ...(alerts.timeoutMs === undefined ? {} : { timeoutMs: alerts.timeoutMs }),
        },
      },
    };
  }
  if (alerts.channel === 'slack') {
    if (alerts.webhookUrl === undefined) {
      throw new Error('mcp.guardrails.alerts: slack requires a webhookUrl');
    }
    return {
      channels: {
        slack: {
          webhookUrl: alerts.webhookUrl,
          ...(alerts.slackChannel === undefined ? {} : { channel: alerts.slackChannel }),
          ...(alerts.slackUsername === undefined ? {} : { username: alerts.slackUsername }),
          ...(alerts.timeoutMs === undefined ? {} : { timeoutMs: alerts.timeoutMs }),
        },
      },
    };
  }
  return { channels: { console: true } };
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
  if (config.auth?.source === undefined && config.auth?.oidc === undefined && config.identity?.verifier === undefined) {
    throw new SchemaError('auth.notConfigured', {}, locale);
  }

  const scope = createSchemaScope(config.systemSchema);
  const pool = createPool(databaseUrl, searchPathOptions(scope.systemSchema));
  const objectRlsRole = resolveObjectRlsRole(config);
  try {
    await assertRestrictedRuntimeAccount(pool, config, locale);
    if (objectRlsRole !== undefined) await assertObjectRlsProvisioned(pool, registry, objectRlsRole, locale, scope);
  } catch (error) {
    await pool.end();
    throw error;
  }

  // optional durable counter store (quotas/budgets); absent = zero overhead
  let quotas: CounterStore | undefined;
  if (config.quotas?.store !== undefined) {
    // host-injected store (enterprise E3/E6: Redis / metered counters)
    quotas = config.quotas.store;
  } else if (config.quotas !== undefined) {
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

  const metrics = config.observability?.metrics ?? NOOP_METRICS_SINK;
  const trace = config.observability?.trace ?? NOOP_TRACE_SINK;

  let audit: AuditEngine | undefined;
  let bufferedSink: (AuditSink & { flush(): Promise<void> }) | undefined;
  let outboxRelay: { close(): Promise<void> } | undefined;
  let auditSink: AuditSink = NOOP_AUDIT_SINK;

  // live channel: the event bus is created only when adapters.events is
  // enabled (absent = not imported = zero overhead). The audit sink streams to
  // it (best-effort/transactional at write time; durable from the relay).
  const eventsCfg = config.adapters?.events;
  let eventBus: EventBus | undefined;
  let eventPublisher: EventPublisher | undefined;
  if (eventsCfg?.enabled) {
    const { createEventBus, publisherOf } = await import('../infrastructure/event/index.js');
    eventBus = createEventBus({ maxEvents: eventsCfg.replay?.maxEvents });
    eventPublisher = publisherOf(eventBus);
  }

  if (subsystems.audit?.enabled) {
    const mode = subsystems.audit.mode ?? AUDIT_MODES.BEST_EFFORT;
    const auditMod = await import('../subsystems/audit/index.js');
    audit = await auditMod.createAudit(pool);
    // a host-injected sink replaces the mode-built inner sink (enterprise E2:
    // export/retention/WORM); the durability guard + events wrapper still apply.
    const injectedAuditSink = subsystems.audit.sink;
    if (injectedAuditSink !== undefined) {
      auditSink = injectedAuditSink;
    } else if (mode === AUDIT_MODES.TRANSACTIONAL) {
      auditSink = auditMod.createTransactionalAuditSink(audit);
    } else if (mode === AUDIT_MODES.DURABLE) {
      auditSink = auditMod.createOutboxAuditSink(pool);
      outboxRelay = auditMod.startAuditOutboxRelay({
        pool,
        publish: eventPublisher === undefined ? undefined : (event) => eventPublisher!.publishAudit(event),
      });
    } else {
      bufferedSink = auditMod.createBufferedAuditSink(audit, subsystems.audit.batch);
      auditSink = bufferedSink;
    }
    // wrap the resolved inner sink (tee: e.g. enterprise E2 export) before the
    // events dual-emit so exports see every persisted event.
    const wrapSink = subsystems.audit.wrap;
    if (wrapSink !== undefined) auditSink = wrapSink(auditSink);
    if (eventPublisher !== undefined && mode !== AUDIT_MODES.DURABLE) {
      // dual-emit to live subscribers (durable publishes from the relay instead)
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
        ...(inner.recordInTx === undefined ? {} : { recordInTx: inner.recordInTx }),
      };
    }
    auditMod.assertAuditSinkCapability(mode, auditSink, {
      allowBestEffortFallback: subsystems.audit.allowBestEffortFallback,
    });
  }

  // Guardrail policies + approval queue are shared by the tool open-contract and
  // by workflow transitions (a transition policy self-filters on `ctx.action`,
  // e.g. it must check `ctx.action.startsWith('workflow.transition.')`).
  let policies: GuardrailPolicy[] = [];
  let approvals: ApprovalsQueue | undefined;
  if (config.tools !== undefined) {
    policies = await resolvePolicies(config.tools.guardrails?.policies, config.schemaDir ?? '.');
    // Create the queue only when it can be used (tools path, explicit config, a
    // transition policy, or a `requiresApproval` transition) — avoid an eager
    // PG table for a config that has none of them.
    const needsApprovals =
      config.tools.approvals !== undefined ||
      config.tools.toolsDir !== undefined ||
      policies.length > 0;
    if (needsApprovals) {
      // persisted approvals by default (PG — the engine's mandated DB); opt out
      // with `approvals.backend: 'memory'`, or inject an external backend
      // instance (enterprise E3: Redis / HA). The approval queue must be durable /
      // multi-instance consistent, so it is never left single-process in-memory
      // for a release engine.
      const approvalsBackend = config.tools.approvals?.backend;
      const approvalTtlMs = config.tools.approvals?.ttlMs;
      const approvalEvents = config.tools.approvals?.events;
      if (approvalsBackend !== undefined && typeof approvalsBackend === 'object') {
        approvals = createApprovals({
          audit: auditSink,
          backend: approvalsBackend,
          ...(approvalTtlMs === undefined ? {} : { ttlMs: approvalTtlMs }),
          ...(approvalEvents === undefined ? {} : { events: approvalEvents }),
        });
      } else if (approvalsBackend !== 'memory') {
        const { createApprovalsBackend } = await import('../subsystems/approvals/index.js');
        const backend = await createApprovalsBackend(pool);
        approvals = createApprovals({
          audit: auditSink,
          backend,
          ...(approvalTtlMs === undefined ? {} : { ttlMs: approvalTtlMs }),
          ...(approvalEvents === undefined ? {} : { events: approvalEvents }),
        });
      } else {
        approvals = createApprovals({
          audit: auditSink,
          ...(approvalTtlMs === undefined ? {} : { ttlMs: approvalTtlMs }),
          ...(approvalEvents === undefined ? {} : { events: approvalEvents }),
        });
      }
    }
  }

  // The script subsystem needs a data-access to serve `this.db.objects` RPCs,
  // while the engine's exposed data-access needs the script dispatcher to fire
  // hooks. The cycle is resolved by giving the bridge its own RBAC-decorated
  // instance over the same base and adding the dispatcher to the exposed one.
  // Same shape for the workflow timer scheduler: a proxy lets writes re-arm
  // timers before the scheduler is built (a no-op until it is assigned).
  let workflowScheduler: WorkflowTimerScheduler | undefined;
  const workflowTimers: WorkflowTimerSync = {
    sync: (object, id, state) => workflowScheduler?.sync(object, id, state) ?? Promise.resolve(),
    cancel: (object, id) => workflowScheduler?.cancel(object, id) ?? Promise.resolve(),
  };
  const replay = subsystems.audit?.replay === true;
  const budget = resolveQueryBudget(config.queryBudget);
  const totalMode = config.query?.total;
  // schema signature: registry-derived; used by the MCP compiled-surface cache
  // key (schema change invalidates it) and recorded on evidence for correlation
  const schemaRevision = createHash('sha256')
    .update(
      JSON.stringify(
        [...registry.list()]
          .map((d) => ({
            n: d.name,
            f: d.fields.map((x) => x.name),
            p: (d as { permissions?: unknown }).permissions ?? null,
          }))
          .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)),
      ),
    )
    .digest('hex');
  let evidenceSink: EvidenceSink | undefined;
  if (config.evidence?.sink !== undefined) {
    // host-injected sink (enterprise E2: evidence export / compliance reports)
    evidenceSink = config.evidence.sink;
  } else if (config.evidence?.enabled === true) {
    const { createEvidenceSink } = await import('../subsystems/evidence/index.js');
    evidenceSink = createEvidenceSink(pool);
  }
  const baseDataAccess = createDataAccess({ audit: auditSink, metrics, replay, events: eventPublisher, policies, approvals, workflowTimers, budget, evidence: evidenceSink, schemaRevision, ...(objectRlsRole === undefined ? {} : { rls: { role: objectRlsRole } }), ...(totalMode === undefined ? {} : { total: totalMode }) });

  let script: ScriptDispatcher | undefined;
  let dataAccess: ObjectDataAccess;
  if (subsystems.script?.enabled) {
    const { createScriptDispatcher } = await import('../subsystems/script/index.js');
    const rbacDataAccess = withRbac(baseDataAccess, { audit: auditSink, metrics });
    script = await createScriptDispatcher({
      objectsDir: join(config.schemaDir ?? '.', 'objects'),
      registry,
      pool,
      dataAccess: rbacDataAccess,
      services: subsystems.script.services,
      config: subsystems.script,
      budget,
      locale,
    });
    dataAccess = withRbac(createDataAccess({ audit: auditSink, metrics, script, replay, events: eventPublisher, policies, approvals, workflowTimers, budget, evidence: evidenceSink, schemaRevision, ...(objectRlsRole === undefined ? {} : { rls: { role: objectRlsRole } }), ...(totalMode === undefined ? {} : { total: totalMode }) }), { audit: auditSink, metrics });
  } else {
    dataAccess = withRbac(baseDataAccess, { audit: auditSink, metrics });
  }
  const identityCfg = config.identity;
  // engine-owned identity directory: handles only (no I/O) unless onStart sync
  const identityStore = identityCfg?.store ?? new PgIdentityStore(pool);
  const identityDirectory = new PgIdentityDirectory(identityStore);
  if (identityCfg?.sync?.onStart === true && identityCfg.source !== undefined) {
    const source = resolveIdentitySource(identityCfg.source, pool);
    await runIdentitySync(source, identityStore, { deactivateMissing: identityCfg.sync.deactivateMissing });
  }
  let authenticator: Authenticator =
    identityCfg?.verifier !== undefined
      ? createDirectoryAuthenticator({ verifier: identityCfg.verifier, directory: identityDirectory, locale })
      : config.auth?.oidc !== undefined
        ? createDirectoryAuthenticator({ verifier: createOidcVerifier(config.auth.oidc), directory: identityDirectory, locale })
        : buildAuthenticator({ source: config.auth?.source ?? {} });
  if (identityCfg?.required === true) {
    authenticator = enforceSyncedIdentity(authenticator, identityDirectory, locale);
  }
  // row-scope: stamp the configured default scope on subjects that lack one
  if (config.scope?.enabled === true && config.scope.defaultScope !== undefined) {
    authenticator = withDefaultScope(authenticator, config.scope.defaultScope);
  }

  // tool mechanism: load custom tools when config.tools.toolsDir is set
  // (absent = not loaded = zero overhead). The executor wraps the RBAC-decorated
  // data-access; rate limiting stays at the adapter layer (per-agent credential), the
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
        ...(evidenceSink === undefined ? {} : { evidence: evidenceSink }),
      }),
    };
  }

  // workflow `onTimeout` scheduler — load only when the subsystem is enabled
  if (subsystems.workflow?.enabled) {
    const { createWorkflowScheduler } = await import('../subsystems/workflow/index.js');
    workflowScheduler = await createWorkflowScheduler({
      pool,
      registry,
      dataAccess,
      script,
      config: subsystems.workflow,
      locale,
    });
  }

  const rest = config.adapters?.rest;
  const mcpCfg = config.adapters?.mcp;
  const graphqlCfg = config.adapters?.graphql;
  const logLevel = (process.env.WEAVEKIT_LOG_LEVEL as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent') ?? 'info';
  // forceCloseConnections: on close, terminate lingering keep-alive/long-lived
  // connections (e.g. SSE /api/events) instead of letting `server.close()` wait
  // on them — otherwise hot reload (`weave dev`) hangs while a frontend is
  // subscribed to the live channel.
  const app = Fastify({ logger: { level: logLevel }, bodyLimit: rest?.bodyLimit ?? 1_048_576, forceCloseConnections: true });
  // request-level telemetry (labels: method/route/status only — no tenant/SQL/secrets)
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? request.url;
    const labels = { method: request.method, route, status: String(reply.statusCode) };
    const durationMs = reply.elapsedTime;
    metrics.histogram(METRIC_NAMES.HTTP_REQUEST_DURATION_MS, durationMs, labels);
    metrics.counter(METRIC_NAMES.HTTP_RESPONSE, 1, labels);
    const traceHeader = request.headers.traceparent;
    const ctx = parseTraceparent(Array.isArray(traceHeader) ? traceHeader[0] : traceHeader);
    if (ctx !== undefined) {
      const now = new Date();
      trace.recordSpan({
        name: route,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        startedAt: new Date(now.getTime() - durationMs),
        endedAt: now,
        durationMs,
        status: reply.statusCode >= 500 ? 'error' : 'ok',
        attributes: { method: request.method, route },
      });
    }
  });
  const httpRoutes = await registerHttpRoutes({
    app,
    locale,
    config,
    registry,
    pool,
    dataAccess,
    authenticator,
    audit,
    auditSink,
    mcpCfg,
    identityCfg,
    identityStore,
    approvals,
  });
  const proxyHandle = httpRoutes.proxy;

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
  // injected: audit (buffered subsystem sink or NOOP), notifications
  // (createNotificationSink — console default), identity (mcp.identities:
  // static dir or a customer-provided IdentityResolver).
  let mcp: McpServerHandle | undefined;
  if (mcpCfg?.enabled ?? true) {
    const guardrailNotifications = mcpCfg?.guardrails?.notifications;
    const legacyAlerts = mcpCfg?.guardrails?.alerts;
    if (guardrailNotifications !== undefined && legacyAlerts !== undefined) {
      throw new Error('mcp.guardrails: use either `notifications` or deprecated `alerts`, not both');
    }
    const notifications = createNotificationSink(
      guardrailNotifications ??
        (legacyAlerts === undefined ? { channels: { console: true } } : legacyAlertsConfig(legacyAlerts)),
    );
    mcp = registerMcp(app, {
      engine: {
        registry,
        pool,
        dataAccess,
        locale,
        ...(approvals === undefined ? {} : { approvals }),
        adminRoles: mcpCfg?.adminRoles ?? rest?.adminRoles ?? [],
      },
      authenticator,
      mcp: mcpCfg,
      locale,
      audit: auditSink,
      notifications,
      tools,
      directory: identityDirectory,
      corsOrigin: config.adapters?.rest?.cors?.origin,
      schemaRevision,
      ...(config.auth?.oidc === undefined ? {} : { oauth: config.auth.oidc }),
    });
  }

  // GraphQL adapter (adapters.graphql): disabled unless explicitly enabled. It
  // reuses the same RBAC-decorated data-access + authenticator as REST/MCP, so
  // field-level RBAC/RLS and write auditing come from the existing layers.
  let graphqlHandle: GraphQLServerHandle | undefined;
  if (graphqlCfg?.enabled === true) {
    graphqlHandle = registerGraphQL(app, {
      engine: { registry, pool, dataAccess, locale },
      authenticator,
      graphql:
        graphqlCfg.security?.maxDepth === undefined
          ? { ...graphqlCfg, security: { ...graphqlCfg.security, maxDepth: budget.maxDepth } }
          : graphqlCfg,
      locale,
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
    graphql: graphqlHandle,
    tools,
    events: eventPublisher,
    proxy: proxyHandle,
    audit,
    quotas,
    script,
    approvals,
    workflow: workflowScheduler,
    observability: { metrics, trace },
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
      await graphqlHandle?.close().catch((error) => warn('graphql', error));
      await workflowScheduler?.close().catch((error) => warn('workflow', error));
      await script?.close().catch((error) => warn('script', error));
      await outboxRelay?.close().catch((error) => warn('audit outbox', error));
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

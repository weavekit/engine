import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import {
  createSlidingWindow,
  type AuditSink,
  type IdentitySubject,
  type Locale,
  type ObjectRegistry,
  type ProxyTargetResolver,
} from '../core/index.js';
import type { IdentityStore } from '../core/provider/identity/index.js';
import type { ObjectDataAccess } from './data-access/index.js';
import type { EngineConfig, EngineIdentityConfig } from './config-types.js';
import type { ProxyForwarder } from './proxy/index.js';
import type { Authenticator } from '../adapters/auth/index.js';
import { wwwAuthenticateChallenge } from '../adapters/auth/index.js';
import type { EngineMcpConfig } from '../adapters/mcp/index.js';
import type { ApprovalsQueue } from './tools/index.js';
import type { AuditEngine } from '../subsystems/audit/index.js';
import { IdentityAdmin, resolveIdentitySource } from './identity/index.js';
import {
  registerAuditRoutes,
  registerApprovalsRoutes,
  registerCapabilitiesRoutes,
  registerMetadataRoutes,
  registerObjectRoutes,
  registerPermissionsRoutes,
  registerProxyRoutes,
  registerIngressRoutes,
  registerSchemaRoutes,
  registerGuardrailsRoutes,
  registerIdentitiesRoutes,
  registerIdentitySyncRoutes,
  registerWorkflowRoutes,
  registerWorkflowSourceRoutes,
  setErrorHandlers,
  type RestOptions,
} from '../adapters/rest/index.js';
import { registerScriptRoutes } from '../adapters/rest/scripts.js';
import { registerIdentityAdminRoutes } from '../adapters/rest/identityAdmin.js';

/**
 * Register the HTTP (REST + admin) routes on the app — extracted from
 * `engine.ts` (2.1 maintainability). The assembly resolves the runtime deps and
 * hands them here; this module only wires routes. Returns the proxy handle when
 * `config.proxy.resolver` is set.
 */
export interface HttpRouteDeps {
  app: FastifyInstance;
  locale: Locale;
  config: EngineConfig;
  registry: ObjectRegistry;
  pool: Pool;
  dataAccess: ObjectDataAccess;
  authenticator: Authenticator;
  audit?: AuditEngine;
  auditSink: AuditSink;
  mcpCfg?: EngineMcpConfig;
  identityCfg?: EngineIdentityConfig;
  identityStore: IdentityStore;
  approvals?: ApprovalsQueue;
}

export interface HttpRoutes {
  proxy?: { forwarder: ProxyForwarder; resolver: ProxyTargetResolver };
}

export async function registerHttpRoutes(deps: HttpRouteDeps): Promise<HttpRoutes> {
  const {
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
  } = deps;
  const rest = config.adapters?.rest;
  let proxyHandle: HttpRoutes['proxy'];

  if (rest?.enabled ?? true) {
    setErrorHandlers(
      app,
      locale,
      config.auth?.oidc === undefined
        ? {}
        : { wwwAuthenticate: (request) => wwwAuthenticateChallenge(`${request.protocol}://${request.host}`) },
    );
    const restOptions: RestOptions = { prefix: rest?.prefix };
    if (rest?.rateLimit !== undefined) {
      restOptions.rateLimiter = createSlidingWindow(rest.rateLimit);
    }
    restOptions.adminRoles = rest?.adminRoles;
    restOptions.principalFor = rest?.principalFor;
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
        identities: typeof mcpCfg?.identities === 'object' ? (mcpCfg.identities as Record<string, IdentitySubject>) : undefined,
      },
      restOptions,
    );
    // greenfield identity administration (admin-gated): list/create/enable users
    registerIdentityAdminRoutes(app, { authenticator, locale, admin: new IdentityAdmin(identityStore) }, restOptions);
    // identity sync trigger (admin-gated): manually provision the configured source
    if (identityCfg?.source !== undefined) {
      registerIdentitySyncRoutes(
        app,
        {
          authenticator,
          locale,
          store: identityStore,
          source: resolveIdentitySource(identityCfg.source, pool),
          ...(identityCfg.sync?.deactivateMissing === undefined ? {} : { deactivateMissingDefault: identityCfg.sync.deactivateMissing }),
        },
        restOptions,
      );
    }
    // capabilities (feature/entitlement) read-only: baseline + host-injected provider
    registerCapabilitiesRoutes(
      app,
      { authenticator, locale, ...(config.capabilities?.provider === undefined ? {} : { capabilities: config.capabilities.provider }) },
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
    // workflow definition source (admin GET/PUT spec) — only when a project dir is configured
    registerWorkflowSourceRoutes(
      app,
      { registry, authenticator, locale, projectDir: config.schemaDir, commitIdentity: config.commit?.identity },
      restOptions,
    );

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

  return proxyHandle === undefined ? {} : { proxy: proxyHandle };
}

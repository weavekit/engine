import type { FastifyInstance } from 'fastify';
import type { Locale, IdentitySubject, ToolDefinition } from '../../core/index.js';
import type { AuditSink } from '../../core/audit/index.js';
import type { AlertSink } from '../../core/provider/alerts/index.js';
import type { IdentityDirectory, IdentityResolver } from '../../core/provider/identity/index.js';
import type { ToolExecutor } from '../../runtime/tools/index.js';
import type { Authenticator } from '../auth/index.js';
import { McpSessionStore } from './session.js';
import { createGuardrails, type RateLimitConfig } from './guardrails.js';
import { registerMcpRoutes } from './http.js';
import type { McpEngine } from './types.js';

/**
 * MCP adapter assembly. `registerMcp` wires the session store + guardrails +
 * per-session transports onto a fastify app under `/mcp`. The assembly layer
 * (createEngine) injects the real sinks: alerts from `infrastructure/alerts`,
 * audit from the audit subsystem (or NOOP), identity from `mcp.identities`.
 */

export interface EngineMcpConfig {
  /** default true: adapters.* undeclared = enabled */
  enabled?: boolean;
  /** HTTP path the endpoint is mounted on; defaults to `/mcp` */
  endpoint?: string;
  guardrails?: {
    rateLimit?: RateLimitConfig;
    /** alerts sink config (channel/url/...) — consumed by the assembly layer's createAlerts */
    alerts?: {
      channel?: 'console' | 'webhook' | 'slack';
      url?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      webhookUrl?: string;
      slackChannel?: string;
      slackUsername?: string;
    };
  };
  /**
   * on-behalf-of identity source: a static directory (`ref → subject`) or a
   * custom resolver. A resolver may be async and load the user (and their
   * roles/team) from the customer's own database.
   */
  identities?: Record<string, IdentitySubject> | IdentityResolver;
  /**
   * call-level impersonation (`onBehalfOf` tool argument): `off` (default)
   * rejects a per-call identity override; `directory` allows switching to any
   * identity in the configured directory. The session-bound identity
   * (`X-Weavekit-On-Behalf-Of` at handshake) is always enforced.
   */
  impersonation?: 'off' | 'directory';
}

export interface McpRegisterDeps {
  engine: McpEngine;
  authenticator: Authenticator;
  mcp: EngineMcpConfig | undefined;
  locale: Locale;
  audit?: AuditSink;
  alerts?: AlertSink;
  /** custom tools (loaded definitions + protocol-agnostic executor) */
  tools?: { defs: ToolDefinition[]; executor: ToolExecutor };
  /**
   * CORS origin to allow on hijacked MCP responses (mirrors
   * `adapters.rest.cors.origin`). The streamable-HTTP transport hijacks the
   * reply, which bypasses the @fastify/cors onSend hook — so the header is
   * written here for browser-based MCP clients.
   */
  corsOrigin?: string | string[] | boolean;
  /** engine identity directory; used as the on-behalf-of resolver when `mcp.identities` is unset */
  directory?: IdentityDirectory;
  /** schema signature: part of the compiled-surface cache key so a schema change invalidates it */
  schemaRevision?: string;
}

export interface McpServerHandle {
  /** closes all transports/servers and clears the session store */
  close(): Promise<void>;
}

/**
 * Register the MCP endpoint on an existing fastify app. Sinks are injected:
 * `audit` (buffered audit sink or NOOP), `alerts` (defaults to a console sink),
 * identity (`mcp.identities`: static directory or a customer-provided resolver).
 */
export function registerMcp(app: FastifyInstance, deps: McpRegisterDeps): McpServerHandle {
  const { engine, authenticator, mcp, locale, audit, alerts, tools, corsOrigin, directory, schemaRevision } = deps;

  // on-behalf-of resolver priority: a function `mcp.identities` wins, then a
  // static `mcp.identities` map, then the engine identity directory, else empty
  const explicit = mcp?.identities;
  const identityResolver: IdentityResolver =
    typeof explicit === 'function'
      ? explicit
      : explicit !== undefined
        ? (ref: string) => (explicit as Record<string, IdentitySubject>)[ref] ?? null
        : directory !== undefined
          ? (ref: string) => directory.resolve(ref)
          : () => null;

  const guardrails = createGuardrails({
    rateLimit: mcp?.guardrails?.rateLimit,
    alerts,
    audit,
  });

  const sessionStore = new McpSessionStore();
  registerMcpRoutes(app, {
    engine,
    authenticator,
    identityResolver,
    guardrails,
    sessionStore,
    locale,
    tools,
    endpoint: mcp?.endpoint,
    corsOrigin,
    allowImpersonation: mcp?.impersonation === 'directory',
    schemaRevision,
  });

  return {
    async close() {
      guardrails.dispose();
      sessionStore.dispose();
    },
  };
}

export { McpSessionStore } from './session.js';
export type { McpSession, SessionInput } from './session.js';
export { createGuardrails } from './guardrails.js';
export type { RateLimitConfig, McpGuardrails } from './guardrails.js';
export type { McpEngine, McpToolSpec, McpToolResult, JsonSchema } from './types.js';
export { compileToolsFor } from './generate.js';
export { registerMcpRoutes } from './http.js';

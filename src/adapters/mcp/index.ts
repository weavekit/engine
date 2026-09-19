import type { FastifyInstance } from 'fastify';
import type { Locale, RbacSubject, ToolDefinition } from '../../core/index.js';
import type { AuditSink } from '../../core/audit/index.js';
import type { AlertSink } from '../../core/provider/alerts/index.js';
import type { IdentityResolver } from '../../core/provider/identity/index.js';
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
  identities?: Record<string, RbacSubject> | IdentityResolver;
}

export interface McpRegisterDeps {
  engine: McpEngine;
  authenticator: Authenticator;
  mcp: EngineMcpConfig | undefined;
  locale: Locale;
  audit?: AuditSink;
  alerts?: AlertSink;
  /** M10 custom tools (loaded definitions + protocol-agnostic executor) */
  tools?: { defs: ToolDefinition[]; executor: ToolExecutor };
  /**
   * CORS origin to allow on hijacked MCP responses (mirrors
   * `adapters.rest.cors.origin`). The streamable-HTTP transport hijacks the
   * reply, which bypasses the @fastify/cors onSend hook — so the header is
   * written here for browser-based MCP clients.
   */
  corsOrigin?: string | string[] | boolean;
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
  const { engine, authenticator, mcp, locale, audit, alerts, tools, corsOrigin } = deps;

  // default resolver over a static directory; a function identity source wins
  const identityResolver: IdentityResolver =
    typeof mcp?.identities === 'function'
      ? mcp.identities
      : (ref: string) => {
          const subject = (mcp?.identities ?? {}) as Record<string, RbacSubject>;
          return subject[ref] ?? null;
        };

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

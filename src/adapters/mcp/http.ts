import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Locale, ToolDefinition } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { ToolExecutor } from '../../runtime/tools/index.js';
import type { Authenticator } from '../auth/index.js';
import { authenticate } from '../auth/index.js';
import type { IdentityResolver } from '../../core/provider/identity/index.js';
import type { McpSessionStore, SessionInput, McpSession } from './session.js';
import type { McpGuardrails } from './guardrails.js';
import { compileToolsFor, type CompiledTool } from './generate.js';
import type { McpEngine, McpToolResult } from './types.js';
import type { AuditEvent } from '../../core/audit/index.js';
import { ACTION_PREFIXES, AUDIT_ACTOR_TYPES } from '../../core/audit/index.js';
import { version } from '../../version.js';

/**
 * Fastify adapter for the MCP endpoint (`/mcp`, streamable HTTP).
 *
 * Session lifecycle: the first POST that carries an `initialize` request (and no
 * `Mcp-Session-Id` header) establishes a session — the Bearer key is resolved to
 * the agent subject, and `X-Weavekit-On-Behalf-Of` resolves to the proxied user
 * whose identity binds the session. `tools/list` and `tools/call` then run
 * against that identity (double-layer RBAC).
 *
 * Transport wiring: the SDK's streamable-HTTP transport is stateful per session
 * and the SDK `Server` may only `connect()` to one transport, so each session
 * gets its own transport + server pair, stored by session id.
 */

const SESSION_HEADER = 'mcp-session-id';
const ON_BEHALF_OF_HEADER = 'x-weavekit-on-behalf-of';

/** resolve the Access-Control-Allow-Origin value (cors origin semantics, mirrors events/stream) */
function allowOrigin(cors: string | string[] | boolean | undefined, requestOrigin: string | undefined): string | undefined {
  if (cors === undefined || cors === false) return undefined;
  if (cors === true) return requestOrigin;
  if (typeof cors === 'string') return cors;
  return requestOrigin !== undefined && cors.includes(requestOrigin) ? requestOrigin : undefined;
}

/**
 * Inject `access-control-allow-origin` into every `writeHead` call on the raw
 * response. The streamable-HTTP transport manages the reply itself after
 * `reply.hijack()` (bypassing the @fastify/cors onSend hook), so the header is
 * patched here instead of relying on a Fastify hook.
 */
function injectCorsOrigin(raw: ServerResponse, value: string): void {
  const original = raw.writeHead as unknown as (
    statusCode: number,
    statusMessage?: string | Record<string, unknown>,
    headers?: Record<string, unknown>,
  ) => ServerResponse;
  raw.writeHead = ((statusCode: number, statusMessage?: string | Record<string, unknown>, headers?: Record<string, unknown>) => {
    let message = statusMessage;
    let hdrs = headers;
    if (typeof message !== 'string') {
      hdrs = message as Record<string, unknown> | undefined;
      message = undefined;
    }
    hdrs = { ...(hdrs ?? {}), 'access-control-allow-origin': value };
    return message === undefined
      ? original.call(raw, statusCode, hdrs as never)
      : original.call(raw, statusCode, message, hdrs as never);
  }) as typeof raw.writeHead;
}

export interface McpHttpDeps {
  engine: McpEngine;
  authenticator: Authenticator;
  identityResolver: IdentityResolver;
  guardrails: McpGuardrails;
  sessionStore: McpSessionStore;
  locale: Locale;
  /** M10 custom tools: loaded definitions + the protocol-agnostic executor */
  tools?: { defs: ToolDefinition[]; executor: ToolExecutor };
  /** HTTP path to mount the endpoint on; defaults to `/mcp` */
  endpoint?: string;
  /**
   * CORS origin to allow on hijacked responses (mirrors `adapters.rest.cors.origin`).
   * The streamable-HTTP transport owns the raw reply after `reply.hijack()`,
   * bypassing the @fastify/cors onSend hook — so the header is injected into
   * every `writeHead` call instead (`true` reflects the request origin).
   */
  corsOrigin?: string | string[] | boolean;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  connected: boolean;
}

/** audit a denied tool call (tool outside the session surface) — best-effort */
function auditDeniedTool(
  guardrails: McpGuardrails,
  session: McpSession,
  tool: string,
  args: unknown,
): void {
  const event: AuditEvent = {
    actorType: AUDIT_ACTOR_TYPES.AGENT,
    actorId: session.agentKey,
    action: `${ACTION_PREFIXES.MCP_TOOL}.${tool}`,
    objectName: undefined,
    changes: args,
    isError: true,
    errorCode: 'mcp.tool.notFound',
    meta: {
      onBehalfOf: session.onBehalfOf,
      subjectId: session.user.id,
      roles: session.user.roles,
      agentLabel: session.agentSubject.id,
      tool,
    },
    timestamp: new Date(),
  };
  void guardrails.audit(event);
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpHttpDeps): void {
  const { engine, authenticator, identityResolver, guardrails, locale, endpoint, tools } = deps;
  const sessionStore: McpSessionStore = deps.sessionStore;
  const path = endpoint ?? '/mcp';
  const sessions = new Map<string, SessionEntry>();

  /** per-subject compiled surface cache (D8: kills the per-request full recompile on list AND call) */
  const surfaceCache = new Map<string, CompiledTool[]>();
  function surfaceFor(session: McpSession): CompiledTool[] {
    const key = `${session.user.id}:${[...session.user.roles].sort().join(',')}`;
    let cached = surfaceCache.get(key);
    if (cached === undefined) {
      cached = compileToolsFor(engine, session.user, tools);
      surfaceCache.set(key, cached);
    }
    return cached;
  }

  /** one server per session: request handlers bound to that session's user identity */
  function buildServer(sessionId: () => string | undefined): Server {
    const server = new Server(
      { name: 'weavekit', version },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const sid = sessionId();
      const session = sid === undefined ? undefined : sessionStore.get(sid);
      if (session === undefined) throw new SchemaError('mcp.session.notFound', { session: sid }, locale);
      const toolsList = surfaceFor(session).map((t) => ({
        name: t.spec.name,
        description: t.spec.description,
        inputSchema: t.spec.inputSchema,
      }));
      return { tools: toolsList };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const sid = sessionId();
      const session = sid === undefined ? undefined : sessionStore.get(sid);
      if (session === undefined) throw new SchemaError('mcp.session.notFound', { session: sid }, locale);
      const name = request.params.name;
      const tool = surfaceFor(session).find((t) => t.spec.name === name);
      if (tool === undefined) {
        // a tool outside the session's surface: audit the attempt (call-layer deny)
        auditDeniedTool(guardrails, session, name, request.params.arguments);
        throw new SchemaError('mcp.tool.notFound', { tool: name }, locale);
      }
      const ctx = { engine, session, guardrails, resolveIdentity: identityResolver };
      const result: McpToolResult = await tool.spec.handler((request.params.arguments ?? {}) as Record<string, unknown>, ctx);
      return result as unknown as CallToolResult;
    });

    return server;
  }

  /**
   * Create a fresh session entry. The identity is bound when the SDK transport
   * assigns the session id (inside handleRequest), so the session record is
   * created in `onsessioninitialized`.
   */
  function createSession(agentKey: string, input: SessionInput): SessionEntry {
    const entry: SessionEntry = {} as SessionEntry;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessionStore.create(sid, input);
        sessions.set(sid, entry);
      },
      onsessionclosed: (sid: string) => {
        sessions.delete(sid);
        sessionStore.delete(sid);
      },
    });
    entry.transport = transport;
    entry.server = buildServer(() => transport.sessionId);
    entry.connected = false;
    return entry;
  }

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // authenticate before entering the transport (401 stays a plain HTTP error)
    const agentSubject = await authenticate(authenticator, request.headers.authorization, locale);

    const header = request.headers[SESSION_HEADER];
    const sessionId = Array.isArray(header) ? header[0] : header;
    let entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;

    const body = request.body as unknown;
    if (entry === undefined && sessionId === undefined && body !== undefined && isInitializeRequest(body)) {
      // new session: bind the proxied user from the header (fail closed on missing/unknown)
      const obh = request.headers[ON_BEHALF_OF_HEADER];
      const onBehalfOf = Array.isArray(obh) ? obh[0] : obh;
      if (onBehalfOf === undefined) {
        throw new SchemaError('mcp.onBehalfOf.missing', {}, locale);
      }
      const user = await identityResolver(onBehalfOf);
      if (user === null) {
        throw new SchemaError('mcp.identity.unknown', { ref: onBehalfOf }, locale);
      }
      // agentKey = the raw API key (the audit actor identity), while the RBAC
      // subject stays the resolved key subject
      const authHeader = request.headers.authorization;
      const rawKey = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : agentSubject.id;
      entry = createSession(rawKey, {
        agentKey: rawKey,
        agentSubject,
        user,
        onBehalfOf,
      });
    }

    if (entry === undefined) {
      throw new SchemaError('mcp.session.notFound', { session: sessionId ?? '(none)' }, locale);
    }

    // one-time connect: the SDK server assumes ownership of the transport
    if (!entry.connected) {
      await entry.server.connect(entry.transport);
      entry.connected = true;
    }

    // CORS: the transport hijacks the reply and writes its own headers, so inject
    // the allow-origin header into every writeHead on the raw response.
    const corsValue = allowOrigin(deps.corsOrigin, request.headers.origin);
    if (corsValue !== undefined) injectCorsOrigin(reply.raw, corsValue);

    reply.hijack();
    await entry.transport.handleRequest(request.raw, reply.raw, request.body);
  }

  app.post(path, handle);
  app.get(path, handle);
  app.delete(path, handle);

  app.addHook('onClose', async () => {
    for (const entry of sessions.values()) {
      await entry.transport.close();
      await entry.server.close();
    }
    sessions.clear();
    sessionStore.dispose();
  });
}

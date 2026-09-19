import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RbacSubject } from '../../core/index.js';
import {
  AUDIT_ACTOR_TYPES,
  isAllowedProxyPath,
  PROXY_KEY_SCOPES,
  SchemaError,
  type AuditSink,
  type Locale,
  type ProxyAllow,
  type ProxyMethod,
  type ProxyRequest,
  type ProxyTarget,
  type ProxyTargetResolver,
} from '../../core/index.js';
import type { ProxyForwarder } from '../../runtime/proxy/index.js';
import type { ProxyStream } from '../../runtime/proxy/index.js';
import type { Authenticator } from '../auth/index.js';
import type { RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';

/** everything the proxy routes need (assembly injects resolver + forwarder) */
export interface ProxyRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  resolver: ProxyTargetResolver;
  forwarder: ProxyForwarder;
  /** audit sink for depth-2 proxy writes; optional (no-op when disabled). */
  audit?: AuditSink;
}

interface ProxyParams {
  instance: string;
  '*': string;
}

/** a target as exposed to the browser — the customer-engine key is never leaked. */
function publicTarget(target: ProxyTarget): {
  id: string;
  url: string;
  keyScope: ProxyTarget['keyScope'];
  labels: ProxyTarget['labels'];
} {
  return { id: target.id, url: target.url, keyScope: target.keyScope, labels: target.labels };
}

/** is the caller asking for a Server-Sent Event stream (mirrors client.subscribe headers)? */
function wantsSse(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept[0] : accept;
  return value !== undefined && value.includes('text/event-stream');
}

/** pass the client's `last-event-id` upstream so the customer engine replays missed events. */
function passthroughHeaders(request: FastifyRequest): Record<string, string> | undefined {
  const raw = request.headers['last-event-id'];
  if (raw === undefined) return undefined;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === undefined ? undefined : { 'last-event-id': v };
}

/** hijack the reply and pipe the upstream SSE body through to the client. */
async function streamSse(reply: FastifyReply, stream: ProxyStream): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  const contentType = stream.response.headers.get('content-type') ?? 'text/event-stream';
  raw.writeHead(stream.response.status, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders?.();
  raw.setTimeout(0);
  const body = Readable.fromWeb(stream.response.body as unknown as ReadableStream<Uint8Array>);
  // cancel the upstream request when the browser disconnects / the pipe ends
  const abort = (): void => stream.abort();
  raw.on('close', abort);
  body.on('error', abort);
  try {
    await pipeline(body, raw);
  } catch {
    // client went away / upstream closed — abort and let the reply clean up
    abort();
  }
}

/**
 * Generic engine proxy routes (P-3; gateway, app-agnostic):
 *   GET   {prefix}/proxy                       — list resolvable targets for the subject (resolver.list)
 *   GET   {prefix}/proxy/:instance/*           — read passthrough (path within `allow.read`)
 *   POST/PATCH/PUT/DELETE {prefix}/proxy/:instance/* — write passthrough (path within `allow.write`,
 *                                                     needs `keyScope=admin` + subject admin)
 *
 * The path is NOT enumerated per resource — it is gated by `isAllowedProxyPath(allow)` prefix
 * matching, so new engine/business REST surfaces are reachable by widening the allowlist. Depth-2
 * writes are audited to the same `weavekit_audit` stream.
 */
export function registerProxyRoutes(
  app: FastifyInstance,
  deps: ProxyRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;
  // A target has no fallback allowlist: an absent `proxy_allow` means nothing is
  // allowed (deny-all). The full-open default is written explicitly by the app
  // (seeds / creation) from `DEFAULT_PROXY_ALLOW` — never auto-applied here.
  const EMPTY_ALLOW: ProxyAllow = { read: [], write: [] };
  const proxyPath = `${prefix}/proxy/:instance/*`;

  async function resolveTarget(request: FastifyRequest): Promise<{ subject: RbacSubject; target: ProxyTarget; instance: string; path: string }> {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const { instance } = request.params as ProxyParams;
    const raw = (request.params as ProxyParams)['*'];
    const path = typeof raw === 'string' ? raw : '';
    const target = await deps.resolver.resolve(instance, subject);
    if (target === null) {
      throw new SchemaError('proxy.notFound', { instance }, locale);
    }
    return { subject, target, instance, path };
  }

  function proxyRequest(request: FastifyRequest, method: ProxyMethod, instance: string, path: string): ProxyRequest {
    return {
      instance,
      method,
      path,
      query: request.query as Record<string, string | undefined>,
      body: request.body,
      ...(passthroughHeaders(request) === undefined ? {} : { headers: passthroughHeaders(request)! }),
    };
  }

  async function forwardWrite(
    req: FastifyRequest,
    reply: FastifyReply,
    method: ProxyMethod,
  ): Promise<void> {
    const { subject, target, instance, path } = await resolveTarget(req);
    if (!isAllowedProxyPath(method, path, target.allow ?? EMPTY_ALLOW)) {
      throw new SchemaError('proxy.denied', { instance, target: target.id }, locale);
    }
    if (target.keyScope !== PROXY_KEY_SCOPES.ADMIN) {
      throw new SchemaError('proxy.denied', { instance, target: target.id }, locale);
    }
    requireAdmin(subject.roles, 'proxy', options.adminRoles, locale);
    if (deps.audit !== undefined) {
      void deps.audit.record({
        actorType: AUDIT_ACTOR_TYPES.USER,
        actorId: subject.id,
        action: `proxy.${method}`,
        objectName: instance,
        changes: req.body,
        meta: { path, target: target.id },
        timestamp: new Date(),
      });
    }
    const res = await deps.forwarder.forward(target, proxyRequest(req, method, instance, path));
    reply.status(res.status).send(res.body);
  }

  // route `GET /api/proxy` before the wildcard so static wins over the param route.
  app.get(`${prefix}/proxy`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const list = deps.resolver.list !== undefined ? await deps.resolver.list(subject) : [];
    return list.map(publicTarget);
  });

  app.get(proxyPath, async (request, reply) => {
    const { target, instance, path } = await resolveTarget(request);
    if (!isAllowedProxyPath('GET', path, target.allow ?? EMPTY_ALLOW)) {
      throw new SchemaError('proxy.denied', { instance, target: target.id }, locale);
    }
    const sse = wantsSse(request);
    const req = proxyRequest(request, 'GET', instance, path);
    if (sse && deps.forwarder.forwardStream !== undefined) {
      const stream = await deps.forwarder.forwardStream(target, req);
      await streamSse(reply, stream);
      return;
    }
    const res = await deps.forwarder.forward(target, req);
    reply.status(res.status).send(res.body);
  });
  app.post(proxyPath, async (request, reply) => {
    await forwardWrite(request, reply, 'POST');
  });
  app.patch(proxyPath, async (request, reply) => {
    await forwardWrite(request, reply, 'PATCH');
  });
  app.put(proxyPath, async (request, reply) => {
    await forwardWrite(request, reply, 'PUT');
  });
  app.delete(proxyPath, async (request, reply) => {
    await forwardWrite(request, reply, 'DELETE');
  });
}

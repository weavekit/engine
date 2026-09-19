import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerProxyRoutes } from '../../src/adapters/rest/proxy.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import { AUDIT_ACTOR_TYPES, DEFAULT_PROXY_ALLOW } from '../../src/core/index.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';
import type { Locale } from '../../src/core/i18n/index.js';
import type { ProxyForwarder } from '../../src/runtime/proxy/index.js';
import type { ProxyTarget, ProxyTargetResolver, AuditSink } from '../../src/core/index.js';

const locale: Locale = 'en';
const ADMIN = { id: 'u-admin', roles: ['admin'] };
const VIEWER = { id: 'u-viewer', roles: ['viewer'] };

function fakeAuthenticator(): Authenticator {
  return {
    resolve: async (header?: string) => {
      if (header === 'Bearer admin-key') return ADMIN;
      if (header === 'Bearer viewer-key') return VIEWER;
      return null;
    },
  };
}

const TARGETS: Record<string, ProxyTarget> = {
  conn1: { id: 'conn1', url: 'https://eng.example.com', apiKey: 'secret-key', keyScope: 'admin', allow: DEFAULT_PROXY_ALLOW },
  conn2: { id: 'conn2', url: 'https://eng.example.com', apiKey: 'secret-key', keyScope: 'read', allow: DEFAULT_PROXY_ALLOW },
};

function resolver(list?: ProxyTarget[]): ProxyTargetResolver {
  return {
    resolve: async (instance) => TARGETS[instance] ?? null,
    ...(list === undefined ? {} : { list: async () => list }),
  };
}

function resolverFrom(targets: Record<string, ProxyTarget>): ProxyTargetResolver {
  return { resolve: async (instance) => targets[instance] ?? null };
}

interface AuditEventCapture {
  events: unknown[];
  sink: AuditSink;
}

function auditSink(): AuditEventCapture {
  const events: unknown[] = [];
  const sink: AuditSink = {
    record: async (event) => {
      events.push(event);
    },
  };
  return { events, sink };
}

interface ForwarderCapture {
  replies: Array<{ target: ProxyTarget; req: unknown }>;
  forwarder: ProxyForwarder;
}

function forwarding(status = 200): ForwarderCapture {
  const replies: Array<{ target: ProxyTarget; req: unknown }> = [];
  const forwarder: ProxyForwarder = {
    forward: async (target, req) => {
      replies.push({ target, req });
      return { status, body: { ok: true } };
    },
    forwardStream: async (target, req) => {
      replies.push({ target, req });
      return {
        response: new Response('data: {"type":"x","payload":{}}\n\n', {
          status,
          headers: { 'content-type': 'text/event-stream' },
        }),
        abort: () => {},
      };
    },
  };
  return { replies, forwarder };
}

async function buildApp(opts: {
  resolver?: ProxyTargetResolver;
  forwarder?: ProxyForwarder;
  audit?: AuditSink;
  adminRoles?: string[];
}) {
  const app = Fastify();
  setErrorHandlers(app, locale);
  registerProxyRoutes(
    app,
    {
      authenticator: fakeAuthenticator(),
      locale,
      resolver: opts.resolver ?? resolver(),
      forwarder: opts.forwarder ?? forwarding().forwarder,
      audit: opts.audit,
    },
    { prefix: '/api', adminRoles: opts.adminRoles ?? ['admin'] },
  );
  await app.ready();
  return app;
}

describe('registerProxyRoutes — read passthrough', () => {
  it('requires auth (401 without a key)', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/audit' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('passes a read path in the read allowlist through to the forwarder', async () => {
    const cap = forwarding(200);
    const app = await buildApp({ forwarder: cap.forwarder });
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/audit', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(200);
    expect(cap.replies.length).toBe(1);
    expect(cap.replies[0]!.req).toEqual({ instance: 'conn1', method: 'GET', path: 'audit', query: {}, body: undefined });
    await app.close();
  });

  it('404s for an unregistered instance', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/proxy/nope/audit', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('proxy.notFound');
    await app.close();
  });

  it('403s a read path outside the read allowlist', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/graphql', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('proxy.denied');
    await app.close();
  });
});

describe('registerProxyRoutes — write passthrough', () => {
  it('gates writes to a connection with keyScope=admin', async () => {
    const app = await buildApp({});
    // conn2 is a read-only keyScope → write denied even for an admin subject
    const res = await app.inject({ method: 'POST', url: '/api/proxy/conn2/approvals/x', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('proxy.denied');
    await app.close();
  });

  it('gates writes to an admin subject', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'POST', url: '/api/proxy/conn1/approvals/x', headers: { authorization: 'Bearer viewer-key' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('denies write paths outside the write allowlist', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/proxy/conn1/objects/x',
      payload: { name: 'x' },
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('proxy.denied');
    await app.close();
  });

  it('forwards an allowed write and records a proxy audit event', async () => {
    const cap = forwarding(200);
    const audit = auditSink();
    const app = await buildApp({ forwarder: cap.forwarder, audit: audit.sink });
    const res = await app.inject({
      method: 'POST',
      url: '/api/proxy/conn1/approvals/abc/approve',
      payload: { decision: 'approve' },
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.replies[0]!.req).toMatchObject({ method: 'POST', path: 'approvals/abc/approve', body: { decision: 'approve' } });
    expect(audit.events.length).toBe(1);
    expect(audit.events[0]).toMatchObject({
      actorType: AUDIT_ACTOR_TYPES.USER,
      actorId: 'u-admin',
      action: 'proxy.POST',
      objectName: 'conn1',
      meta: { path: 'approvals/abc/approve', target: 'conn1' },
    });
    await app.close();
  });
});

describe('registerProxyRoutes — SSE streaming passthrough', () => {
  // SSE hijacks the reply (reply.hijack + raw pipe), which light-my-request
  // (`app.inject`) cannot stream — exercise it over a real ephemeral listener.
  async function listenAndFetch(app: ReturnType<typeof buildApp> extends Promise<infer A> ? A : never, path: string, headers: Record<string, string>) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return fetch(`http://127.0.0.1:${port}${path}`, { headers });
  }

  it('streams /events when the client asks for text/event-stream', async () => {
    const cap = forwarding(200);
    const app = await buildApp({ forwarder: cap.forwarder });
    const res = await listenAndFetch(app as never, '/api/proxy/conn1/events', {
      authorization: 'Bearer admin-key',
      accept: 'text/event-stream',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('data: {"type":"x"');
    expect(cap.replies[0]!.req).toMatchObject({ method: 'GET', path: 'events' });
    await app.close();
  });

  it('forwards last-event-id and still buffers a non-SSE GET', async () => {
    const cap = forwarding(200);
    const app = await buildApp({ forwarder: cap.forwarder });
    const sse = await listenAndFetch(app as never, '/api/proxy/conn1/events', {
      authorization: 'Bearer admin-key',
      accept: 'text/event-stream',
      'last-event-id': '7',
    });
    expect(sse.status).toBe(200);
    await sse.text();
    expect(cap.replies[0]!.req).toMatchObject({ method: 'GET', path: 'events', headers: { 'last-event-id': '7' } });

    const plain = await app.inject({
      method: 'GET',
      url: '/api/proxy/conn1/audit',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('registerProxyRoutes — per-instance allowlist', () => {
  it('lets a connection own its allowlist (a provided allow supersedes any default)', async () => {
    const limited: ProxyTarget = { ...TARGETS.conn1!, allow: { read: ['audit'], write: ['approvals'] } };
    const app = await buildApp({ resolver: resolverFrom({ conn1: limited }) });
    // conn1's own allow (audit only) denies objects
    const objects = await app.inject({ method: 'GET', url: '/api/proxy/conn1/objects/x', headers: { authorization: 'Bearer admin-key' } });
    expect(objects.statusCode).toBe(403);
    expect(objects.json().error.code).toBe('proxy.denied');
    // audit is still reachable through the connection's own allowlist
    const audit = await app.inject({ method: 'GET', url: '/api/proxy/conn1/audit', headers: { authorization: 'Bearer admin-key' } });
    expect(audit.statusCode).toBe(200);
    await app.close();
  });

  it('grants a path a connection explicitly allows', async () => {
    const open: ProxyTarget = { ...TARGETS.conn2!, allow: { read: ['graphql'], write: [] } };
    const app = await buildApp({ resolver: resolverFrom({ conn2: open }) });
    // conn2 override exposes graphql (denied by default)
    const gql = await app.inject({ method: 'GET', url: '/api/proxy/conn2/graphql', headers: { authorization: 'Bearer admin-key' } });
    expect(gql.statusCode).toBe(200);
    await app.close();
  });

  it('denies everything for a connection with no allowlist (no fallback to a default)', async () => {
    const closed: ProxyTarget = { id: 'conn3', url: 'https://eng.example.com', apiKey: 'secret-key', keyScope: 'admin' };
    const app = await buildApp({ resolver: resolverFrom({ conn3: closed }) });
    for (const path of ['audit', 'metadata', 'objects/connections', 'events']) {
      const res = await app.inject({ method: 'GET', url: `/api/proxy/conn3/${path}`, headers: { authorization: 'Bearer admin-key' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('proxy.denied');
    }
    await app.close();
  });
});

describe('registerProxyRoutes — target list', () => {
  it('lists resolvable targets without the connection key', async () => {
    const app = await buildApp({ resolver: resolver([TARGETS.conn1!, TARGETS.conn2!]) });
    const res = await app.inject({ method: 'GET', url: '/api/proxy', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([
      { id: 'conn1', url: 'https://eng.example.com', keyScope: 'admin', labels: undefined },
      { id: 'conn2', url: 'https://eng.example.com', keyScope: 'read', labels: undefined },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret-key');
    await app.close();
  });

  it('returns [] when the resolver has no list()', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/proxy', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});

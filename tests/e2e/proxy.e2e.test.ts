import { createServer, type Server } from 'node:http';
import { describe, it, expect, before, after } from '../helpers/test.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerProxyRoutes } from '../../src/adapters/rest/proxy.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import { createProxyForwarder } from '../../src/runtime/proxy/index.js';
import { DEFAULT_PROXY_ALLOW } from '../../src/core/index.js';
import type { ProxyTarget, ProxyTargetResolver } from '../../src/core/index.js';
import type { Authenticator } from '../../src/adapters/auth/index.js';

/**
 * Proxy/tunnel mechanism E2E over a **real** local upstream: protocol (method /
 * path / body), the security model (the target's key is authoritative and never
 * the caller's), concurrency, timeout and body-size boundaries. No PostgreSQL.
 */

const secretKey = 'target-secret-key';

let upstream: Server;
let app: FastifyInstance;
let port = 0;

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.startsWith('/api/slow')) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ slow: true }));
        }, 400);
        return;
      }
      if (url.startsWith('/api/large')) {
        const big = 'x'.repeat(2_000_000);
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(big.length) });
        res.end(big);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url,
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const target: ProxyTarget = {
    id: 'conn1',
    url: `http://127.0.0.1:${port}`,
    apiKey: secretKey,
    keyScope: 'admin',
    allow: { read: ['audit', 'slow', 'large', 'down'], write: ['approvals'] },
  };
  const down: ProxyTarget = { ...target, id: 'down', url: 'http://127.0.0.1:1' };
  const resolver: ProxyTargetResolver = {
    resolve: async (instance) => (instance === 'conn1' ? target : instance === 'down' ? down : null),
  };
  const authenticator: Authenticator = {
    resolve: async (header) => (header === 'Bearer admin-key' ? { id: 'admin', roles: ['admin'] } : null),
  };

  app = Fastify();
  setErrorHandlers(app, 'en');
  registerProxyRoutes(
    app,
    { authenticator, locale: 'en', resolver, forwarder: createProxyForwarder({ timeoutMs: 150, maxBodyBytes: 100_000 }) },
    { prefix: '/api', adminRoles: ['admin'] },
  );
  await app.ready();
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('proxy E2E (real upstream)', () => {
  it('forwards a read: method/path preserved, target key authoritative (caller key never forwarded)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/proxy/conn1/audit?actorId=x',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { method: string; url: string; auth: string };
    expect(body.method).toBe('GET');
    expect(body.url).toContain('/api/audit');
    expect(body.url).toContain('actorId=x');
    expect(body.auth).toBe(`Bearer ${secretKey}`);
    expect(body.auth).not.toContain('admin-key');
  });

  it('forwards an allowed write with the JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/proxy/conn1/approvals/abc/approve',
      payload: { decision: 'approve' },
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { method: string; body: string };
    expect(body.method).toBe('POST');
    expect(JSON.parse(body.body)).toEqual({ decision: 'approve' });
  });

  it('denies a path outside the allowlist (boundary)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/objects/x', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('proxy.denied');
  });

  it('handles concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: 'GET', url: '/api/proxy/conn1/audit', headers: { authorization: 'Bearer admin-key' } }),
      ),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect((results[0]!.json() as { method: string }).method).toBe('GET');
  });

  it('times out a slow upstream with 504 proxy.timeout', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/slow', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('proxy.timeout');
  });

  it('maps an unreachable upstream to 502 proxy.unreachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proxy/down/audit', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('proxy.unreachable');
  });

  it('rejects an oversized upstream response with 502 proxy.responseTooLarge', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proxy/conn1/large', headers: { authorization: 'Bearer admin-key' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('proxy.responseTooLarge');
  });

  it('forwarder rejects an unsafe path directly (defense in depth)', async () => {
    const forwarder = createProxyForwarder();
    let code: unknown;
    try {
      await forwarder.forward(
        { ...({ id: 'c', url: `http://127.0.0.1:${port}`, apiKey: secretKey, keyScope: 'admin', allow: DEFAULT_PROXY_ALLOW } as ProxyTarget) },
        { instance: 'c', method: 'GET', path: '../secret', query: {} },
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('proxy.denied');
  });
});

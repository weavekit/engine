import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { registerProxyRoutes } from '../../src/adapters/rest/proxy.js';
import { setErrorHandlers } from '../../src/adapters/rest/errorHandler.js';
import { createProxyForwarder } from '../../src/runtime/proxy/index.js';

test('proxy streams a download with content-disposition (no buffering)', async () => {
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/api/download')) {
      res.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="audit.csv"',
      });
      res.end('a,b\n1,2\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddr = upstream.address();
  const upstreamPort = typeof upstreamAddr === 'object' && upstreamAddr !== null ? upstreamAddr.port : 0;

  const app = Fastify();
  setErrorHandlers(app, 'en');
  registerProxyRoutes(
    app,
    {
      authenticator: {
        resolve: async (header) => (header === 'Bearer k' ? { id: 'a', roles: ['admin'] } : null),
      },
      locale: 'en',
      resolver: {
        resolve: async (id) =>
          id === 'c'
            ? {
                id: 'c',
                url: `http://127.0.0.1:${upstreamPort}`,
                apiKey: 'target-key',
                keyScope: 'admin',
                allow: { read: ['download'], write: [] },
              }
            : null,
      },
      forwarder: createProxyForwarder({ timeoutMs: 1000 }),
    },
    { prefix: '/api', adminRoles: ['admin'] },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appAddr = app.server.address();
  const appPort = typeof appAddr === 'object' && appAddr !== null ? appAddr.port : 0;

  try {
    const res = await fetch(`http://127.0.0.1:${appPort}/api/proxy/c/download`, {
      headers: { authorization: 'Bearer k' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(await res.text(), 'a,b\n1,2\n');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

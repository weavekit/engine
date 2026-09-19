import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { TunnelRegistry, TunnelSession, createTunnelForwarder, connectTunnel, createTunnelServer } from '../../src/runtime/tunnel/index.js';
import type { ProxyRequest, ProxyTarget } from '../../src/index.js';

function engineServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('framing: encode + read a frame over a duplex stream', async () => {
  const pt = new PassThrough();
  const session = new TunnelSession(pt as unknown as import('node:stream').Duplex);
  session.write({ kind: 'response-start', id: 7, status: 200, headers: { 'content-type': 'application/json' } });
  session.write({ kind: 'data', id: 7, data: 'abc' });
  session.write({ kind: 'response-end', id: 7 });

  const f1 = await session.read();
  assert.equal(f1?.kind, 'response-start');
  const f2 = await session.read();
  assert.equal(f2?.kind, 'data');
  const f3 = await session.read();
  assert.equal(f3?.kind, 'response-end');
});

test('server + connector + forwarder: routes a proxied request over the tunnel', async () => {
  const engine = await engineServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rows: [{ id: 'L1' }] }));
  });
  const registry = new TunnelRegistry();
  const server = createTunnelServer({
    registry,
    authenticate: (tunnelId, token) => tunnelId === 't1' && token === 'tok',
  });
  const port = await server.listen(0);

  const connector = connectTunnel({
    endpoint: `http://127.0.0.1:${port}`,
    tunnelId: 't1',
    pairingToken: 'tok',
    engineUrl: engine.url,
    engineApiKey: 'sk-admin',
  });
  await connector.ready;

  const forwarder = createTunnelForwarder({
    registry,
    base: {
      forward: async () => ({ status: 500, body: { error: 'should not be used' } }),
      forwardStream: async () => {
        throw new Error('should not be used');
      },
    },
  });

  const target: ProxyTarget = { id: 't1', url: 'urn:tunnel', transport: 'tunnel', apiKey: 'sk-admin' };
  const req: ProxyRequest = { instance: 't1', method: 'GET', path: '/audit' };
  const res = await forwarder.forward(target, req);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rows: [{ id: 'L1' }] });

  connector.close();
  await server.close();
  await engine.close();
});

test('forwarder: streams an SSE response over the tunnel', async () => {
  const engine = await engineServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\n');
    res.write('data: {"type":"record.created"}\n\n');
    res.end();
  });
  const registry = new TunnelRegistry();
  const server = createTunnelServer({ registry, authenticate: (id, token) => id === 't1' && token === 'tok' });
  const port = await server.listen(0);
  const connector = connectTunnel({
    endpoint: `http://127.0.0.1:${port}`,
    tunnelId: 't1',
    pairingToken: 'tok',
    engineUrl: engine.url,
    engineApiKey: 'sk-admin',
  });
  await connector.ready;

  const forwarder = createTunnelForwarder({
    registry,
    base: {
      forward: async () => ({ status: 500, body: null }),
      forwardStream: async () => {
        throw new Error('should not be used');
      },
    },
  });
  const target: ProxyTarget = { id: 't1', url: 'urn:tunnel', transport: 'tunnel', apiKey: 'sk-admin' };
  const req: ProxyRequest = { instance: 't1', method: 'GET', path: '/events', headers: { accept: 'text/event-stream' } };
  const { response } = await forwarder.forwardStream(target, req);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /record\.created/);

  connector.close();
  await server.close();
  await engine.close();
});

test('server: rejects a bad pairing_token', async () => {
  const registry = new TunnelRegistry();
  const server = createTunnelServer({ registry, authenticate: (id, token) => id === 't1' && token === 'tok' });
  const port = await server.listen(0);
  const connector = connectTunnel({
    endpoint: `http://127.0.0.1:${port}`,
    tunnelId: 't1',
    pairingToken: 'BAD',
    engineUrl: 'http://127.0.0.1:1',
    engineApiKey: 'sk',
  });
  await assert.rejects(connector.ready);
  connector.close();
  await server.close();
});

import { describe, it, expect } from '../helpers/test.js';import { buildEngineFromRegistry, createPool, migrate, ObjectRegistry, type ObjectDefinition } from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
  ],
  permissions: { sales: { read: 'all', create: true, update: ['name'], delete: true } },
};

maybe('Ops E2E (real engine + local PG): health/ready/version + REST rate limit + CORS + bodyLimit', () => {
  it('ops routes + REST rate limit + CORS + bodyLimit', async () => {
    const pool = createPool(url!);
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_metadata, weavekit_meta CASCADE');

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.buildGraph();
      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        auth: { source: { 'k-sales': { id: 'u1', roles: ['sales'] } } },
        adapters: {
          rest: {
            prefix: '/api',
            rateLimit: { windowMs: 60_000, max: 2 },
            cors: { origin: 'https://app.example.com' },
            bodyLimit: 128,
          },
        },
      });
      const { app, registry } = engine;
      await migrate(registry, { databaseUrl: url! });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const base = `http://127.0.0.1:${addr.port}`;

      // ── ops routes
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ok', db: 'up' });

      const ver = await fetch(`${base}/version`);
      expect(ver.status).toBe(200);
      const verBody = (await ver.json()) as { name: string; version: string };
      expect(verBody.name).toBe('weavekit');
      expect(typeof verBody.version).toBe('string');

      // ── CORS: allowed origin returns Access-Control-Allow-Origin (separate key does not consume rate limit)
      const corsRes = await fetch(`${base}/api/objects/lead`, {
        headers: { origin: 'https://app.example.com', authorization: 'Bearer k-cors' },
      });
      expect(corsRes.headers.get('access-control-allow-origin')).toBe('https://app.example.com');

      // ── REST rate limit: max=2, third request 429
      const h = { authorization: 'Bearer k-sales' };
      expect((await fetch(`${base}/api/objects/lead`, { headers: h })).status).toBe(200);
      expect((await fetch(`${base}/api/objects/lead`, { headers: h })).status).toBe(200);
      const limited = await fetch(`${base}/api/objects/lead`, { headers: h });
      expect(limited.status).toBe(429);
      const limitedBody = (await limited.json()) as { error?: { code?: string } };
      expect(limitedBody.error?.code).toBe('http.rateLimited');

      // ── bodyLimit: 128 bytes, over-limit body → 413
      const big = JSON.stringify({ id: 'x', name: 'y'.repeat(200) });
      const bodyRes = await fetch(`${base}/api/objects/lead`, {
        method: 'POST',
        headers: { authorization: 'Bearer k-sales', 'content-type': 'application/json' },
        body: big,
      });
      expect(bodyRes.status).toBe(413);
    } finally {
      if (engine !== undefined) {
        try {
          await engine.close();
        } catch {
          // already closed
        }
      }
      try {
        await pool.query('DROP TABLE IF EXISTS lead, weavekit_metadata, weavekit_meta CASCADE');
      } catch {
        // pool ended
      }
      await pool.end();
    }
  }, 60000);
});

import { describe, it, expect } from '../helpers/test.js';
import { createHmac } from 'node:crypto';
import {
  assertQuota,
  buildEngineFromRegistry,
  COUNTER_PERIODS,
  createPool,
  migrate,
  ObjectRegistry,
  type CounterStore,
  type InboundEvent,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const SECRET = 'whsec_engine_e2e';
/** HMAC-SHA256 over the exact request bytes (hex) */
const sign = (body: string): string => createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
  ],
};

maybe('External event ingress E2E (real HTTP + HMAC raw body + audit persistence, local PG)', () => {
  it('raw body signature verification → handling → audit → 202; tampered/missing signature → 401 (fail-closed)', async () => {
    const pool = createPool(url!);
    let engine: WeaveKitEngine | undefined;
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();

      const seen: InboundEvent[] = [];
      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-app': { id: 'app', roles: ['admin'] } } },
        subsystems: { audit: { enabled: true } },
        ingress: {
          verifier: (request) => {
            const signature = request.headers['x-signature'];
            if (typeof signature !== 'string' || signature !== sign(request.rawBody)) return null;
            return { source: request.source, type: 'invoice.paid', id: 'evt_1', payload: JSON.parse(request.rawBody) };
          },
          handler: (event) => void seen.push(event),
        },
      });
      await migrate(engine.registry, { databaseUrl: url! });
      await engine.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = engine.app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const post = (body: string, headers: Record<string, string>): Promise<Response> =>
        fetch(`${baseUrl}/api/ingress/billing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        });

      // the verifier signs the exact bytes — whitespace/newlines must survive
      const body = '{\n  "amount": 42,\n  "id": "evt_1"\n}';
      const accepted = await post(body, { 'x-signature': sign(body) });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ accepted: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        source: 'billing',
        type: 'invoice.paid',
        id: 'evt_1',
        payload: { amount: 42, id: 'evt_1' },
      });

      // a signature for a different byte sequence is rejected
      expect((await post(body, { 'x-signature': sign(`${body} `) })).status).toBe(401);
      // missing signature is rejected too
      expect((await post(body, {})).status).toBe(401);
      expect(seen).toHaveLength(1);
    } finally {
      await engine?.close();
      await pool.end();
    }

    // engine.close() flushed the buffered audit sink — the receipt is durable
    const auditPool = createPool(url!);
    try {
      const rows = await auditPool.query(
        "SELECT actor_type, actor_id, action FROM weavekit_audit WHERE action = 'ingress.billing'",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ actor_type: 'system', actor_id: 'billing', action: 'ingress.billing' });
    } finally {
      await auditPool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await auditPool.end();
    }
  }, 30000);

  it('per-source rate limiting → 429, and different sources do not affect each other', async () => {
    const pool = createPool(url!);
    let engine: WeaveKitEngine | undefined;
    try {
      await pool.query('DROP TABLE IF EXISTS lead CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();
      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-app': { id: 'app', roles: ['admin'] } } },
        ingress: {
          rateLimit: { windowMs: 60000, max: 2 },
          verifier: (request) => ({ source: request.source, type: 'ping', payload: null }),
          handler: () => {},
        },
      });
      await migrate(engine.registry, { databaseUrl: url! });
      await engine.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = engine.app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const post = (source: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${addr.port}/api/ingress/${source}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

      expect((await post('shop')).status).toBe(202);
      expect((await post('shop')).status).toBe(202);
      expect((await post('shop')).status).toBe(429);
      // the limiter is keyed per source
      expect((await post('other')).status).toBe(202);
    } finally {
      await engine?.close();
      await pool.query('DROP TABLE IF EXISTS lead CASCADE');
      await pool.end();
    }
  }, 20000);

  it('assertQuota over limit inside handler → HTTP 429 quota.exceeded (engine.quotas + real PG counter)', async () => {
    const pool = createPool(url!);
    let engine: WeaveKitEngine | undefined;
    try {
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_counters CASCADE');
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();

      // config.ingress is defined before the engine exists; the handler closes
      // over the holder and reads engine.quotas at request time
      const holder: { quotas?: CounterStore } = {};
      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-app': { id: 'app', roles: ['admin'] } } },
        quotas: { backend: 'pg' },
        ingress: {
          verifier: (request) => ({ source: request.source, type: 'call', payload: null }),
          handler: async () => {
            await assertQuota(
              holder.quotas!,
              'outbound:partner',
              { limit: 2, period: COUNTER_PERIODS.DAY },
              'en',
              1,
              new Date('2026-03-15T10:00:00Z'),
            );
          },
        },
      });
      holder.quotas = engine.quotas;
      expect(engine.quotas).toBeDefined();
      await migrate(engine.registry, { databaseUrl: url! });
      await engine.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = engine.app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const call = (): Promise<Response> =>
        fetch(`http://127.0.0.1:${addr.port}/api/ingress/partner`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

      expect((await call()).status).toBe(202);
      expect((await call()).status).toBe(202);

      const denied = await call();
      expect(denied.status).toBe(429);
      const body = (await denied.json()) as { error: { code: string } };
      expect(body.error.code).toBe('quota.exceeded');
    } finally {
      await engine?.close();
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_counters CASCADE');
      await pool.end();
    }
  }, 30000);
});

import { describe, it, expect } from '../helpers/test.js';
import {
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  ROW_SCOPE_MARKERS,
  type ObjectDefinition,
} from '../../src/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: true },
  },
};

interface SseBlock {
  id?: string;
  event?: string;
  data?: string;
}

/** parse one SSE block (blank-line separated); comment-only blocks yield no event/data */
function parseBlock(block: string): SseBlock {
  const out: SseBlock = {};
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/^ /, '');
    if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
    else if (field === 'data') out.data = (out.data === undefined ? '' : `${out.data}\n`) + value;
  }
  return out;
}

interface SseClient {
  /** read the next non-ping SSE block; null when the stream ends */
  read(): Promise<SseBlock | null>;
  close(): void;
}

async function openSse(baseUrl: string, headers: Record<string, string>): Promise<SseClient> {
  const ctrl = new AbortController();
  const resPromise = fetch(`${baseUrl}/api/events`, { headers, signal: ctrl.signal });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  const readRaw = async (): Promise<SseBlock | null> => {
    const res = await resPromise;
    if (!res.ok || res.body === null) return null;
    if (reader === undefined) reader = res.body.getReader();
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return parseBlock(block);
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    async read() {
      for (;;) {
        const block = await readRaw();
        if (block === null || block.event !== undefined || block.data !== undefined) return block; // skip `: ping`
      }
    },
    close() {
      ctrl.abort();
    },
  };
}

/** read blocks until one with the given event name appears (returns the full list) */
async function readUntil(sse: SseClient, event: string): Promise<{ blocks: SseBlock[]; target: SseBlock | null }> {
  const blocks: SseBlock[] = [];
  for (;;) {
    const block = await sse.read();
    if (block === null) return { blocks, target: null };
    blocks.push(block);
    if (block.event === event) return { blocks, target: block };
  }
}

maybe('M12 realtime channel E2E (SSE + subscription filtering + replay, local PG + real HTTP)', () => {
  it('auth / record.changed / audit filtering / schema.changed broadcast / replay / gap notice', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();

    const cleanupPool = createPool(url!);
    await cleanupPool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
    await cleanupPool.end();

    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: {
        source: {
          'key-sales': { id: 'u100', roles: ['sales'] },
          'key-ghost': { id: 'u500', roles: ['ghost_role'] },
          'key-admin': { id: 'u900', roles: ['admin'] },
        },
      },
      subsystems: { audit: { enabled: true, batch: { flushMs: 50 } } },
      adapters: { events: { enabled: true, adminRoles: ['admin'] } },
    });
    const { app, pool, dataAccess, registry } = engine;
    const base = { pool, registry };
    const sseClients: SseClient[] = [];

    await migrate(registry0, { databaseUrl: url! });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // ── 1. no key → 401 ──
      const unauth = await fetch(`${baseUrl}/api/events`);
      expect(unauth.status).toBe(401);

      // ── 2. write ops → record.created/updated/deleted ──
      const sales = await openSse(baseUrl, { authorization: 'Bearer key-sales' });
      sseClients.push(sales);
      const sctx = { ...base, subject: { id: 'u100', roles: ['sales'] } };
      await dataAccess.create('lead', { id: 'E1', name: 'n', owner_id: 'u100' }, sctx);
      const created = await readUntil(sales, 'record.created');
      expect(created.target).not.toBeNull();
      expect(JSON.parse(created.target!.data!).payload).toEqual({ object: 'lead', id: 'E1' });

      await dataAccess.update('lead', 'E1', { name: 'n2' }, sctx);
      const updated = await readUntil(sales, 'record.updated');
      expect(updated.target).not.toBeNull();

      await dataAccess.delete('lead', 'E1', sctx);
      const deleted = await readUntil(sales, 'record.deleted');
      expect(deleted.target).not.toBeNull();

      // ── 3. events for unreadable objects invisible to denied subscribers (ghost only sees schema.changed broadcast) ──
      const ghost = await openSse(baseUrl, { authorization: 'Bearer key-ghost' });
      sseClients.push(ghost);
      await dataAccess.create('lead', { id: 'E2', name: 'x', owner_id: 'u100' }, sctx); // sales can read → broadcast
      engine.events?.publishSchemaChanged();
      const ghostBlocks = await readUntil(ghost, 'schema.changed');
      expect(ghostBlocks.target).not.toBeNull();
      expect(ghostBlocks.blocks.some((b) => (b.event ?? '').startsWith('record.'))).toBe(false);

      // ── 4. audit.event: non-admin sees only own actor ──
      await dataAccess.create('lead', { id: 'E3', name: 'a', owner_id: 'u100' }, sctx); // u100
      await dataAccess.create('lead', { id: 'E4', name: 'b', owner_id: 'u100' }, base); // system
      engine.events?.publishSchemaChanged();
      const auditBlocks = await readUntil(sales, 'schema.changed');
      const audits = auditBlocks.blocks
        .filter((b) => b.event === 'audit.event')
        .map((b) => JSON.parse(b.data!).payload.event as { actorId: string });
      expect(audits.some((a) => a.actorId === 'u100')).toBe(true);
      expect(audits.some((a) => a.actorId === 'system')).toBe(false);

      // admin sees all (including system actor)
      const admin = await openSse(baseUrl, { authorization: 'Bearer key-admin' });
      sseClients.push(admin);
      await dataAccess.create('lead', { id: 'E5', name: 'c', owner_id: 'u100' }, base); // system
      engine.events?.publishSchemaChanged();
      const adminAudits = await readUntil(admin, 'schema.changed');
      expect(
        adminAudits.blocks
          .filter((b) => b.event === 'audit.event')
          .some((b) => (JSON.parse(b.data!).payload.event as { actorId: string }).actorId === 'system'),
      ).toBe(true);

      // ── 5. replay: events during disconnect, reconnect with Last-Event-ID backfills ──
      const r1 = await openSse(baseUrl, { authorization: 'Bearer key-sales' });
      sseClients.push(r1);
      await dataAccess.create('lead', { id: 'R1', name: 'r1', owner_id: 'u100' }, sctx);
      const r1Block = await readUntil(r1, 'record.created');
      const lastSeq = r1Block.target!.id!;
      r1.close();
      await dataAccess.create('lead', { id: 'R2', name: 'r2', owner_id: 'u100' }, sctx); // written while unsubscribed
      const r2 = await openSse(baseUrl, { authorization: 'Bearer key-sales', 'last-event-id': lastSeq });
      sseClients.push(r2);
      const replayBlocks = await readUntil(r2, 'record.created');
      expect(replayBlocks.blocks.some((b) => b.data !== undefined && b.data!.includes('"id":"R2"'))).toBe(true);

      // ── 6. gap notice: new engine (empty buffer) + non-empty Last-Event-ID → schema.changed(replayGap) ──
      r2.close();
      const engine2 = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        auth: { source: { 'key-sales': { id: 'u100', roles: ['sales'] } } },
        adapters: { events: { enabled: true } },
      });
      await engine2.app.listen({ host: '127.0.0.1', port: 0 });
      const addr2 = engine2.app.server.address();
      if (addr2 === null || typeof addr2 === 'string') throw new Error('no port');
      const gap = await openSse(`http://127.0.0.1:${addr2.port}`, {
        authorization: 'Bearer key-sales',
        'last-event-id': '5',
      });
      const gapBlock = await readUntil(gap, 'schema.changed');
      expect(gapBlock.target).not.toBeNull();
      expect(gapBlock.target!.data).toContain('replayGap');
      gap.close();
      await engine2.close();
    } finally {
      for (const c of sseClients) c.close();
      await pool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
      await engine.close();
    }
  }, 30000);

  it('SSE response carries CORS headers (hijack bypasses @fastify/cors onSend, stream writes them itself)', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();
    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-sales': { id: 'u100', roles: ['sales'] } } },
      adapters: {
        rest: { cors: { origin: 'http://example.com' } },
        events: { enabled: true },
      },
    });
    try {
      await engine.app.listen({ host: '127.0.0.1', port: 0 });
      const addr = engine.app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
        headers: { authorization: 'Bearer key-sales', origin: 'http://example.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://example.com');
      res.body?.cancel();

      // CORS preflight must allow the engine's full REST surface — @fastify/cors
      // defaults to GET,HEAD,POST, which would break cross-origin PATCH/DELETE
      const preflight = await fetch(`http://127.0.0.1:${addr.port}/api/objects/lead`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://example.com',
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(preflight.status).toBe(204);
      const methods = preflight.headers.get('access-control-allow-methods') ?? '';
      expect(methods).toContain('PATCH');
      expect(methods).toContain('DELETE');
    } finally {
      await engine.close();
    }
  }, 20000);

  it('engine.close() does not hang with an open SSE connection (hot-reload regression)', async () => {
    const registry0 = new ObjectRegistry();
    registry0.register(LEAD);
    registry0.buildGraph();

    const cleanupPool = createPool(url!);
    await cleanupPool.query('DROP TABLE IF EXISTS lead, weavekit_audit, weavekit_metadata, weavekit_meta CASCADE');
    await cleanupPool.end();

    const engine = await buildEngineFromRegistry(registry0, {
      databaseUrl: url!,
      auth: { source: { 'key-sales': { id: 'u100', roles: ['sales'] } } },
      adapters: { events: { enabled: true } },
    });
    await engine.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = engine.app.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const ctrl = new AbortController();
    // keep an SSE connection open across engine.close() — the events adapter's
    // onClose hook must end the stream so server.close() is not left waiting
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
      headers: { authorization: 'Bearer key-sales' },
      signal: ctrl.signal,
    }).catch(() => undefined);
    expect(res?.status).toBe(200);
    try {
      const started = Date.now();
      await Promise.race([
        engine.close(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('engine.close() hung on an open SSE connection')), 5000),
        ),
      ]);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      ctrl.abort();
      try {
        await res?.body?.cancel();
      } catch {
        /* already closed by the server */
      }
    }
  }, 15000);
});

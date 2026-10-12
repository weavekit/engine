import { randomUUID } from 'node:crypto';
import { describe, it, before, after, expect } from '../helpers/test.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  buildEngineFromRegistry,
  createPool,
  encodeRecordKey,
  migrate,
  ObjectRegistry,
  SYSTEM_CAPABILITIES,
  systemPrincipal,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import { queryEvidence } from '../../src/subsystems/evidence/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'pp_lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', ownership: true },
    { name: 'secret', type: 'string' },
  ],
  workflowEnabled: true,
  workflow: { nodes: [{ id: 'review', assign: { roles: ['manager'] } }] },
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: true, fields: { exclude: ['secret'] } },
    manager: { read: 'all', update: true },
  },
};

const alice = { id: randomUUID(), roles: ['sales'] };
const bob = { id: randomUUID(), roles: ['sales'] };
const manager = { id: randomUUID(), roles: ['manager'] };
const PROTOCOLS = ['rest', 'graphql', 'mcp'] as const;
type Protocol = (typeof PROTOCOLS)[number];

/** protocol-neutral outcome: rows/record on success; code (REST/GraphQL) + localized message on failure */
type Outcome = { ok: true; value: unknown } | { ok: false; code?: string; message: string };

interface Driver {
  list(): Promise<Outcome>;
  get(id: string): Promise<Outcome>;
  create(data: Record<string, unknown>): Promise<Outcome>;
  update(id: string, changes: Record<string, unknown>): Promise<Outcome>;
  remove(id: string): Promise<Outcome>;
  transition(id: string, action: string): Promise<Outcome>;
}

const gqlLiteral = (value: Record<string, unknown>): string =>
  `{ ${Object.entries(value).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`;

function restDriver(engine: WeaveKitEngine): Driver {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown): Promise<Outcome> => {
    const res = await engine.app.inject({
      method,
      url: `/api/objects/pp_lead${path}`,
      headers: { authorization: 'Bearer k-alice' },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    if (res.statusCode >= 400) {
      const error = (res.json() as { error: { code: string; message: string } }).error;
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: true, value: res.statusCode === 204 ? null : res.json() };
  };
  return {
    list: async () => {
      const out = await call('GET', '');
      return out.ok ? { ok: true, value: (out.value as { rows: unknown[] }).rows } : out;
    },
    get: (id) => call('GET', `/${id}`),
    create: (data) => call('POST', '', data),
    update: (id, changes) => call('PATCH', `/${id}`, changes),
    remove: (id) => call('DELETE', `/${id}`),
    transition: (id, action) => call('POST', `/${id}/workflow/${action}`, {}),
  };
}

function graphqlDriver(engine: WeaveKitEngine): Driver {
  const call = async (query: string, pick: string): Promise<Outcome> => {
    const res = await engine.app.inject({ method: 'POST', url: '/graphql', headers: { authorization: 'Bearer k-alice' }, payload: { query } });
    const body = res.json() as { data?: Record<string, unknown> | null; errors?: Array<{ message: string; extensions?: { code?: string } }> };
    const error = body.errors?.[0];
    if (error !== undefined) return { ok: false, ...(error.extensions?.code === undefined ? {} : { code: error.extensions.code }), message: error.message };
    return { ok: true, value: body.data?.[pick] };
  };
  const cols = 'id name owner_id secret';
  return {
    list: async () => {
      const out = await call(`{ pp_lead { rows { ${cols} } } }`, 'pp_lead');
      return out.ok ? { ok: true, value: (out.value as { rows: unknown[] }).rows } : out;
    },
    get: async (id) => {
      const out = await call(`{ pp_lead_by_id(id: ${JSON.stringify(id)}) { ${cols} } }`, 'pp_lead_by_id');
      // GraphQL convention: an invisible record resolves to null (REST/MCP: data.recordNotFound)
      return out.ok && out.value === null ? { ok: false, code: 'data.recordNotFound', message: '' } : out;
    },
    create: (data) => call(`mutation { createPpLead(data: ${gqlLiteral(data)}) { ${cols} } }`, 'createPpLead'),
    update: (id, changes) => call(`mutation { updatePpLead(id: ${JSON.stringify(id)}, changes: ${gqlLiteral(changes)}) { ${cols} } }`, 'updatePpLead'),
    remove: (id) => call(`mutation { deletePpLead(id: ${JSON.stringify(id)}) }`, 'deletePpLead'),
    transition: (id, action) => call(`mutation { transitionPpLead(id: ${JSON.stringify(id)}, action: ${JSON.stringify(action)}) { id } }`, 'transitionPpLead'),
  };
}

function mcpDriver(client: Client): Driver {
  const call = async (name: string, args: Record<string, unknown>): Promise<Outcome> => {
    const result = (await client.callTool({ name, arguments: { object: 'pp_lead', ...args } })) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = result.content?.find((b) => b.type === 'text')?.text ?? '';
    return result.isError === true ? { ok: false, message: text } : { ok: true, value: text === '' ? null : JSON.parse(text) };
  };
  return {
    list: async () => {
      const out = await call('search_records', {});
      return out.ok ? { ok: true, value: (out.value as { rows: unknown[] }).rows } : out;
    },
    get: (id) => call('get_record', { id }),
    create: (data) => call('create_record', { data }),
    update: (id, changes) => call('update_record', { id, changes }),
    remove: (id) => call('delete_record', { id }),
    transition: (id, action) => call('workflow_transition', { id, action }),
  };
}

const visible = (rows: unknown) =>
  (rows as Array<Record<string, unknown>>)
    .map((r) => ({ id: r.id, secretExposed: r.secret !== undefined && r.secret !== null }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

for (const enforce of [false, true]) {
  maybe(`Protocol parity E2E (REST / GraphQL / MCP, rls.enforce=${enforce})`, () => {
    let pool: Pool;
    let engine: WeaveKitEngine;
    let mcp: { client: Client; transport: StreamableHTTPClientTransport };
    const drivers = {} as Record<Protocol, Driver>;
    const key = (id: string) => encodeRecordKey([id]);

    before(async () => {
      pool = createPool(url!);
      await pool.query(`DROP TABLE IF EXISTS pp_lead, weavekit_record__pp_lead CASCADE`);
      await pool.query(`DELETE FROM weavekit_workflow_workitems WHERE object = 'pp_lead'`);
      await pool.query(`DELETE FROM weavekit_workflow_steps WHERE object = 'pp_lead'`);
      await pool.query(`DELETE FROM weavekit_workflow_instances WHERE object = 'pp_lead'`);
      await pool.query(`DELETE FROM weavekit_user WHERE id = ANY($1::uuid[])`, [[alice.id, bob.id, manager.id]]);
      await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, '["manager"]'::jsonb, true)`, [manager.id]);
      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();
      await migrate(registry, { databaseUrl: url!, ...(enforce ? { objectRls: { role: 'weavekit_object' } } : {}) });
      await pool.query(`DELETE FROM weavekit_audit WHERE object = 'pp_lead'`);
      await pool.query(`DELETE FROM weavekit_evidence WHERE object = 'pp_lead'`);

      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'k-alice': alice, 'k-agent': { id: 'pp-agent', roles: ['agent'] } } },
        adapters: { graphql: { enabled: true }, mcp: { identities: { alice } } },
        subsystems: { audit: { enabled: true, mode: 'transactional' } },
        evidence: { enabled: true },
        ...(enforce ? { rls: { enforce: true } } : {}),
      });
      const sys = { pool: engine.pool, registry: engine.registry, principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN) };
      await engine.dataAccess.create('pp_lead', { id: 'A', name: 'mine', owner_id: alice.id, secret: 's' }, sys);
      await engine.dataAccess.create('pp_lead', { id: 'B', name: 'theirs', owner_id: bob.id, secret: 's' }, sys);

      await engine.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = engine.app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', `http://127.0.0.1:${addr.port}`), {
        requestInit: { headers: { authorization: 'Bearer k-agent', 'x-weavekit-on-behalf-of': 'alice' } },
      });
      const client = new Client({ name: 'parity', version: '1.0.0' });
      await client.connect(transport);
      mcp = { client, transport };
      drivers.rest = restDriver(engine);
      drivers.graphql = graphqlDriver(engine);
      drivers.mcp = mcpDriver(client);
    });

    after(async () => {
      await mcp?.client.close().catch(() => {});
      await mcp?.transport.close().catch(() => {});
      await engine?.close();
      await pool?.query(`DROP TABLE IF EXISTS pp_lead, weavekit_record__pp_lead CASCADE`);
      await pool?.end();
    });

    /** run one operation on every protocol and return the outcomes keyed by protocol */
    async function each(op: (d: Driver, p: Protocol) => Promise<Outcome>): Promise<Record<Protocol, Outcome>> {
      const out = {} as Record<Protocol, Outcome>;
      for (const p of PROTOCOLS) out[p] = await op(drivers[p], p);
      return out;
    }

    /** every protocol rejected with the same code (REST/GraphQL) and the same localized message */
    function expectSameRejection(outcomes: Record<Protocol, Outcome>, code: string): void {
      for (const p of PROTOCOLS) expect({ p, ok: outcomes[p].ok }).toEqual({ p, ok: false });
      const [rest, gql, mcpOut] = PROTOCOLS.map((p) => outcomes[p] as { code?: string; message: string });
      expect(rest!.code).toBe(code);
      expect(gql!.code).toBe(code);
      if (gql!.message !== '') expect(gql!.message).toBe(rest!.message);
      expect(mcpOut!.message).toBe(rest!.message);
    }

    it('reads: same visible rows, same excluded fields', async () => {
      const lists = await each((d) => d.list());
      for (const p of PROTOCOLS) {
        expect(lists[p].ok).toBe(true);
        expect({ p, rows: visible((lists[p] as { value: unknown }).value) }).toEqual({ p, rows: [{ id: 'A', secretExposed: false }] });
      }
      expectSameRejection(await each((d) => d.get(key('B'))), 'data.recordNotFound');
    });

    it('denials: same code + message for out-of-scope writes, forbidden fields and submit', async () => {
      expectSameRejection(await each((d) => d.update(key('B'), { name: 'x' })), 'data.recordNotFound');
      expectSameRejection(await each((d) => d.update(key('A'), { secret: 'x' })), 'rbac.denied.field');
      expectSameRejection(await each((d) => d.remove(key('B'))), 'data.recordNotFound');
      expectSameRejection(await each((d) => d.transition(key('B'), 'submit')), 'data.recordNotFound');
      const b = await pool.query(`SELECT name FROM pp_lead WHERE id = 'B'`);
      expect(b.rows[0]).toEqual({ name: 'theirs' });
      const inst = await pool.query(`SELECT 1 FROM weavekit_workflow_instances WHERE object = 'pp_lead' AND record_key = $1`, [key('B')]);
      expect(inst.rowCount).toBe(0);
    });

    it('writes: same audit trail and the same evidence per protocol', async () => {
      for (const p of PROTOCOLS) {
        const id = `W-${p}`;
        const created = await drivers[p].create({ id, name: 'n', owner_id: alice.id });
        expect({ p, ok: created.ok }).toEqual({ p, ok: true });
        expect((await drivers[p].update(key(id), { name: 'n2' })).ok).toBe(true);
        expect((await drivers[p].transition(key(id), 'submit')).ok).toBe(true);
        expect((await drivers[p].remove(key(id))).ok).toBe(true);
      }

      const audit = await pool.query(
        `SELECT object_id, action, actor_id FROM weavekit_audit
          WHERE object = 'pp_lead' AND object_id = ANY($1) AND is_error = false ORDER BY id`,
        [PROTOCOLS.map((p) => key(`W-${p}`))],
      );
      for (const p of PROTOCOLS) {
        const rows = (audit.rows as Array<{ object_id: string; action: string; actor_id: string }>).filter((r) => r.object_id === key(`W-${p}`));
        expect({ p, actions: rows.map((r) => r.action) }).toEqual({ p, actions: ['create', 'update', 'transition', 'delete'] });
        expect(rows.every((r) => r.actor_id === alice.id)).toBe(true);
      }

      const { rows: evidence } = await queryEvidence(pool, { objectName: 'pp_lead', subjectId: alice.id, limit: 200 });
      const shape = (p: Protocol) =>
        evidence
          .filter((e) => e.plan.objectId === key(`W-${p}`) || (e.plan.objectId === undefined && (e.plan.args as { id?: string }).id === `W-${p}`))
          .map((e) => `${e.plan.action}:${e.isError ? e.errorCode : 'ok'}:${e.stages.map((s) => s.stage).join('>')}`)
          .sort();
      const expected = shape('rest');
      expect(expected.length).toBe(4);
      expect(shape('graphql')).toEqual(expected);
      expect(shape('mcp')).toEqual(expected);

      // denied out-of-scope writes left the same error evidence on every protocol
      const notFound = evidence.filter((e) => e.isError && e.errorCode === 'data.recordNotFound' && e.plan.objectId === key('B'));
      expect(notFound.length % PROTOCOLS.length).toBe(0);
      expect(notFound.length).toBeGreaterThan(0);
    });
  });
}

import { describe, it, expect } from '../helpers/test.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';
import { AUDIT_ACTOR_TYPES, DATA_ACTIONS } from '../../src/subsystems/audit/index.js';
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
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name', 'status'], delete: true, fields: { exclude: ['secret'] } },
  },
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

maybe('GraphQL E2E (Fastify inject + local PG): mutations + RBAC + audit', () => {
  it('create via GraphQL is RBAC-scoped, field-excluded, and audited by the shared data-access layer', async () => {
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    try {
      const setup = createPool(url!);
      await setup.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      await setup.end();

      const registry = new ObjectRegistry();
      registry.register(LEAD);
      registry.buildGraph();

      engine = await buildEngineFromRegistry(registry, {
        databaseUrl: url!,
        auth: { source: { 'key-sales': { id: 'u-alice', roles: ['sales'] } } },
        adapters: { graphql: { enabled: true }, mcp: { enabled: false } },
        subsystems: { audit: { enabled: true } },
      });

      await migrate(engine.registry, { databaseUrl: url! });

      // seed a row owned by someone else, subject-less (unrestricted)
      await engine.dataAccess.create(
        'lead',
        { id: 'L-other', name: 'Other', status: 'open', owner_id: 'u-other' },
        { pool: engine.pool, registry: engine.registry, principal: { kind: 'system' as const, capability: 'internal.admin' as const } },
      );

      const auth = { authorization: 'Bearer key-sales' };
      const inject = (query: string) =>
        engine!.app.inject({ method: 'POST', url: '/graphql', headers: auth, payload: { query } });

      // ── create (own scope) via GraphQL mutation
      const created = await inject('mutation { createLead(data: { id: "L9", name: "New", owner_id: "u-alice" }) { weave_id name } }');
      expect(created.statusCode).toBe(200);
      const createdBody = JSON.parse(created.body) as { data?: { createLead: { weave_id: string; name: string } }; errors?: unknown };
      expect(createdBody.errors).toBeUndefined();
      expect(createdBody.data!.createLead.name).toBe('New');
      const l9 = encodeRecordKey(['L9']);
      expect(createdBody.data!.createLead.weave_id).toBe(l9);

      // ── row scope: sales only reads its own row (L-other is invisible)
      const list = await inject('{ lead { total rows { name secret } } }');
      const listBody = JSON.parse(list.body) as { data: { lead: { total: number; rows: { name: string; secret: string | null }[] } } };
      expect(listBody.data.lead.total).toBe(1);
      expect(listBody.data.lead.rows[0]!.name).toBe('New');
      expect(listBody.data.lead.rows[0]!.secret).toBeNull(); // fields.exclude → never leaked

      // ── denied field update → rbac.denied.field
      const denied = await inject(`mutation { updateLead(id: "${l9}", changes: { secret: "x" }) { weave_id } }`);
      const deniedBody = JSON.parse(denied.body) as { errors?: { extensions: { code: string } }[] };
      expect(deniedBody.errors?.[0]?.extensions.code).toBe('rbac.denied.field');

      // ── audit: the success create + the denied update are both recorded (fire-and-forget)
      let rows = await engine.audit!.query({ object: 'lead' }).then((r) => r.rows);
      for (let i = 0; i < 200 && !rows.some((r) => r.action === DATA_ACTIONS.CREATE && r.objectId === l9); i += 1) {
        await sleep(10);
        rows = await engine.audit!.query({ object: 'lead' }).then((r) => r.rows);
      }
      const create = rows.find((r) => r.action === DATA_ACTIONS.CREATE && r.objectId === l9);
      expect(create).toBeDefined();
      expect(create!.isError).toBe(false);
      expect(create!.actorType).toBe(AUDIT_ACTOR_TYPES.USER);
      expect(create!.actorId).toBe('u-alice');
      const deniedRow = rows.find((r) => r.action === DATA_ACTIONS.UPDATE && r.objectId === l9 && r.isError);
      expect(deniedRow?.errorCode).toBe('rbac.denied.field');
    } finally {
      if (engine !== undefined) await engine.close();
      const cleanup = createPool(url!);
      await cleanup.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      await cleanup.end();
    }
  }, 60_000);
});

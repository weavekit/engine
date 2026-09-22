import { describe, it, expect } from '../helpers/test.js';import { buildEngineFromRegistry, createPool, migrate, ObjectRegistry, ROW_SCOPE_MARKERS, type ObjectDefinition } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Route B practice: the customer's own user table drives identity. Instead of a
 * static `identities` directory, an async resolver queries `crm_users` for the
 * on-behalf-of ref and returns the RBAC subject (roles/team) from that row. The
 * auth source is likewise a resolver (here: a mock JWT verifier) rather than a
 * static key map.
 */

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name'], delete: false, fields: { exclude: ['secret'] } },
    manager: { read: 'all', create: true, update: true, delete: true },
  },
};

/** the customer's own user table (they own this — the engine never ALTERs it) */
const CRM_USERS = 'crm_users';

async function seedCrmUsers(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${CRM_USERS} CASCADE`);
  await pool.query(
    `CREATE TABLE ${CRM_USERS} (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255), role VARCHAR(50) NOT NULL, team_id VARCHAR(50))`,
  );
  await pool.query(`INSERT INTO ${CRM_USERS} (id, name, role, team_id) VALUES
    ('alice', 'Alice Johnson', 'sales', NULL),
    ('emma', 'Emma Davis', 'finance', NULL),
    ('alex', 'Alex Carter', 'manager', 't1')`);
}

function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1.0.0' },
    },
  };
}

async function newClient(base: string, bearer: string, onBehalfOf: string) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: {
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-weavekit-on-behalf-of': onBehalfOf,
      },
    },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function closeClients(handles: Array<{ client: Client; transport: StreamableHTTPClientTransport }>): Promise<void> {
  for (const h of handles) {
    try {
      await h.client.close();
    } catch {
      // already closed
    }
    try {
      await h.transport.close();
    } catch {
      // already closed
    }
  }
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r.content?.find((b) => b.type === 'text')?.text ?? '';
}

maybe('Route B practice E2E (customer crm_users table + custom async resolver + JWT-style auth)', () => {
  it('auth.source function + mcp.identities function → full path (tool surface + row-level + denial + audit)', async () => {
    const pool = createPool(url!);
    const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    const auditPool = createPool(url!);
    try {
      await seedCrmUsers(pool);

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.buildGraph();

      // route B: auth source is a resolver (mock JWT verify → subject with roles ['agent'])
      const authResolver = (header: string | undefined) => {
        const match = /^Bearer\s+jwt-(\w+)$/.exec(header ?? '');
        if (match === null) return null;
        return { id: `agent-${match[1]}`, roles: ['agent'] };
      };

      // route B: identities resolver queries the customer's own user table
      const identityResolver = async (ref: string) => {
        const res = await pool.query(
          `SELECT id, role, team_id FROM ${CRM_USERS} WHERE id = $1`,
          [ref],
        );
        const row = res.rows[0];
        if (row === undefined) return null;
        const subject: { id: string; roles: string[]; teamId?: string } = { id: row.id, roles: [row.role] };
        if (row.team_id !== null) subject.teamId = row.team_id;
        return subject;
      };

      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        auth: { source: authResolver },
        adapters: {
          mcp: {
            identities: identityResolver,
            guardrails: { rateLimit: { windowMs: 60_000, max: 100 } },
          },
        },
        subsystems: { audit: { enabled: true } },
      });
      const { app, registry, dataAccess } = engine;
      const base = { pool, registry };

      await migrate(registry, { databaseUrl: url! });

      // seed leads: alice owns L1, someone else owns L2
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', owner_id: 'alice', secret: 's1' }, base);
      await dataAccess.create('lead', { id: 'L2', name: 'Globex', owner_id: 'u-other', secret: 's2' }, base);

      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // bad bearer → 401 before transport (resolver returned null)
      const badKey = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt', 'x-weavekit-on-behalf-of': 'alice' },
        body: JSON.stringify(initBody()),
      });
      expect(badKey.status).toBe(401);

      // alice (sales) → own rows only, secret stripped, no delete tool
      const alice = await newClient(baseUrl, 'jwt-1', 'alice');
      clients.push(alice);
      const aliceTools = await alice.client.listTools();
      const aliceNames = aliceTools.tools.map((t) => t.name);
      expect(aliceNames).toContain('search_records');
      expect(aliceNames).toContain('get_record');
      expect(aliceNames).toContain('create_record');
      expect(aliceNames).toContain('update_record');
      expect(aliceNames).not.toContain('delete_record');

      const search = await alice.client.callTool({ name: 'search_records', arguments: { object: 'lead' } });
      const parsed = JSON.parse(textOf(search));
      expect(parsed.total).toBe(1);
      expect(parsed.rows[0].id).toBe('L1');
      expect('secret' in parsed.rows[0]).toBe(false);

      // unknown on-behalf-of → 400 (resolver returned null)
      const ghost = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer jwt-1', 'x-weavekit-on-behalf-of': 'ghost' },
        body: JSON.stringify(initBody()),
      });
      expect(ghost.status).toBe(400);

      await closeClients(clients);
      clients.length = 0;

      // audit: actorId = agent id from the auth resolver, meta.onBehalfOf = alice.
      // The MCP tool audit is enqueued asynchronously after the response, so poll
      // while the engine is still open (its buffered sink flushes every 100ms) —
      // querying after engine.close() can race the deferred enqueue with pool.end().
      let auditRows:
        | { rows: Array<{ actor_id: string; action: string; meta: { onBehalfOf?: string } | string }> }
        | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        auditRows = (await auditPool.query(
          `SELECT actor_id, action, meta FROM weavekit_audit WHERE action = 'mcp.tool.search_records' ORDER BY id DESC LIMIT 1`,
        )) as { rows: Array<{ actor_id: string; action: string; meta: { onBehalfOf?: string } | string }> };
        if (auditRows.rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(auditRows!.rows.length).toBeGreaterThan(0);
      expect(auditRows!.rows[0]!.actor_id).toBe('jwt-1');
      expect((auditRows!.rows[0]!.meta as { onBehalfOf?: string }).onBehalfOf).toBe('alice');

      await engine.close();
      engine = undefined;
    } finally {
      await closeClients(clients);
      if (engine !== undefined) {
        try {
          await engine.close();
        } catch {
          // already closed
        }
      }
      try {
        await auditPool.query(`DROP TABLE IF EXISTS ${CRM_USERS}, lead, weavekit_meta, weavekit_audit CASCADE`);
      } catch {
        // pool ended
      }
      await auditPool.end();
      await pool.end();
    }
  }, 60000);
});

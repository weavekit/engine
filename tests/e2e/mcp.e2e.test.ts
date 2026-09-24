import { describe, it, expect } from '../helpers/test.js';import { buildEngineFromRegistry, migrate, ObjectRegistry, ROW_SCOPE_MARKERS, type ObjectDefinition } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const LEAD: ObjectDefinition = {
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'enum', options: ['open', 'won', 'lost'] },
    { name: 'owner_id', type: 'string', [ROW_SCOPE_MARKERS.OWNERSHIP]: true },
    { name: 'team_id', type: 'string', [ROW_SCOPE_MARKERS.TEAM]: true },
    { name: 'secret', type: 'string' },
  ],
  permissions: {
    sales: { read: 'own', create: true, update: ['name', 'status'], delete: true, fields: { exclude: ['secret'] } },
    finance: { read: 'all', fields: { exclude: ['secret'] } },
  },
};

const TICKET: ObjectDefinition = {
  name: 'ticket',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['draft', 'open'] },
  ],
  workflowEnabled: true,
  workflow: {
    initial: 'draft',
    stateField: 'status',
    states: [{ name: 'draft' }, { name: 'open' }],
    transitions: [{ action: 'open', from: 'draft', to: 'open' }],
  },
  permissions: { sales: { read: 'all', update: true } },
};

const AGENT_KEYS = {
  sales: 'key-sales-rep',
  finance: 'key-finance',
  flood: 'key-flood',
};

const IDENTITIES = {
  alice: { id: 'u-alice', roles: ['sales'] },
  emma: { id: 'u-emma', roles: ['finance'] },
};

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

interface ClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function newClient(base: string, key: string, onBehalfOf: string): Promise<ClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: {
      headers: {
        authorization: `Bearer ${key}`,
        'x-weavekit-on-behalf-of': onBehalfOf,
      },
    },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** close clients first so the fastify app has no open SSE connections */
async function closeClients(handles: ClientHandle[]): Promise<void> {
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

/** extract the first text block from an SDK tool result */
function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r.content?.find((b) => b.type === 'text')?.text ?? '';
}

async function freshPool() {
  const { Pool } = await import('pg');
  return new Pool({ connectionString: url });
}

maybe('MCP E2E (SDK Client + streamable HTTP + local PG): auth + session identity binding + two-layer RBAC', () => {
  it('auth/session binding/tool surface filtering/row-level/field-level/denial/rate limit/audit/introspection', async () => {
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    const clients: ClientHandle[] = [];
    let auditPool = await freshPool();
    try {
      await auditPool.query('DROP TABLE IF EXISTS lead, ticket, weavekit_meta, weavekit_audit CASCADE');
      await auditPool.end();
      auditPool = await freshPool();

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.register(TICKET);
      registry0.buildGraph();
      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        auth: {
          source: {
            [AGENT_KEYS.sales]: { id: 'a-sales', roles: ['agent'] },
            [AGENT_KEYS.finance]: { id: 'a-finance', roles: ['agent'] },
            [AGENT_KEYS.flood]: { id: 'a-flood', roles: ['agent'] },
          },
        },
        adapters: {
          mcp: {
            identities: IDENTITIES,
            guardrails: { rateLimit: { windowMs: 60_000, max: 100 } },
          },
        },
        subsystems: { audit: { enabled: true } },
      });
      const { app, pool, registry, dataAccess } = engine;
      const base = { pool, registry };

      await migrate(registry, { databaseUrl: url! });

      // seed (internal subject-less direct connection, freely set ownership)
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', status: 'open', owner_id: 'u-alice', team_id: 't1', secret: 's1' }, base);
      await dataAccess.create('lead', { id: 'L2', name: 'Globex', status: 'open', owner_id: 'u-other', team_id: 't1', secret: 's2' }, base);
      await dataAccess.create('ticket', { id: 'T1' }, base);

      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // ── 1. auth: wrong key / missing key → 401 (does not enter transport)
      const badKey = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope', 'x-weavekit-on-behalf-of': 'alice' },
        body: JSON.stringify(initBody()),
      });
      expect(badKey.status).toBe(401);

      const noKey = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-weavekit-on-behalf-of': 'alice' },
        body: JSON.stringify(initBody()),
      });
      expect(noKey.status).toBe(401);

      // ── 2. session binding + tool surface filtering: sales full CRUD, finance only search/get
      const alice = await newClient(baseUrl, AGENT_KEYS.sales, 'alice');
      clients.push(alice);
      const aliceTools = await alice.client.listTools();
      const aliceNames = aliceTools.tools.map((t) => t.name);
      expect(aliceNames).toContain('search_records');
      expect(aliceNames).toContain('get_record');
      expect(aliceNames).toContain('create_record');
      expect(aliceNames).toContain('update_record');
      expect(aliceNames).toContain('delete_record');
      expect(aliceNames).toContain('list_objects');
      expect(aliceNames).toContain('describe_object');
      expect(aliceNames).toContain('workflow_transition');

      const emma = await newClient(baseUrl, AGENT_KEYS.finance, 'emma');
      clients.push(emma);
      const emmaTools = await emma.client.listTools();
      const emmaNames = emmaTools.tools.map((t) => t.name);
      expect(emmaNames).toContain('search_records');
      expect(emmaNames).toContain('get_record');
      expect(emmaNames).not.toContain('create_record');
      expect(emmaNames).not.toContain('update_record');
      expect(emmaNames).not.toContain('delete_record');
      expect(emmaNames).not.toContain('workflow_transition');

      // ── 3. search_ row-level (own) + field-level (exclude stripped)
      const search = await alice.client.callTool({ name: 'search_records', arguments: { object: 'lead' } });
      const searchText = textOf(search);
      const parsed = JSON.parse(searchText);
      expect(parsed.total).toBe(1);
      expect(parsed.rows[0].id).toBe('L1');
      expect('secret' in parsed.rows[0]).toBe(false);

      // get_ denied row → isError (row outside own, does not leak existence)
      const scopedOut = await alice.client.callTool({ name: 'get_record', arguments: { object: 'lead', id: 'L2' } });
      expect(scopedOut.isError).toBe(true);

      // unknown object → isError (data.objectUnknown), not a protocol error
      const unknown = await alice.client.callTool({ name: 'search_records', arguments: { object: 'ghost' } });
      expect(unknown.isError).toBe(true);

      // finance (read all + exclude) sees all rows with no secret
      const financeSearch = await emma.client.callTool({ name: 'search_records', arguments: { object: 'lead' } });
      const financeParsed = JSON.parse(textOf(financeSearch));
      expect(financeParsed.total).toBe(2);
      expect('secret' in financeParsed.rows[0]).toBe(false);

      // ── 4. update_ denied: finance tool surface lacks update_record → manual call rejected (call enforced)
      let deniedUpdate: Error | undefined;
      try {
        await emma.client.callTool({ name: 'update_record', arguments: { object: 'lead', id: 'L1', changes: { name: 'x' } } });
      } catch (e) {
        deniedUpdate = e as Error;
      }
      expect(deniedUpdate).toBeDefined();
      expect(deniedUpdate!.message).toContain('update_record');

      // sales legal update (within whitelist)
      const okUpdate = await alice.client.callTool({
        name: 'update_record',
        arguments: { object: 'lead', id: 'L1', changes: { name: 'Acme2' } },
      });
      expect(okUpdate.isError).toBe(false);
      expect(JSON.parse(textOf(okUpdate) || '{}').name).toBe('Acme2');

      // sales update outside the whitelist → call-level RBAC denial (isError), not a protocol error
      const badField = await alice.client.callTool({
        name: 'update_record',
        arguments: { object: 'lead', id: 'L1', changes: { secret: 'x' } },
      });
      expect(badField.isError).toBe(true);

      // ── 4b. workflow_transition: the agent fires a declared transition
      const transitioned = await alice.client.callTool({
        name: 'workflow_transition',
        arguments: { object: 'ticket', id: 'T1', action: 'open' },
      });
      expect(transitioned.isError).toBe(false);
      expect(JSON.parse(textOf(transitioned)).status).toBe('open');

      // an unknown/disallowed transition → isError (call-level), not a protocol error
      const badTransition = await alice.client.callTool({
        name: 'workflow_transition',
        arguments: { object: 'ticket', id: 'T1', action: 'ghost' },
      });
      expect(badTransition.isError).toBe(true);

      // ── 5. unknown on-behalf-of → session establishment fails (explicit error)
      const ghost = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_KEYS.sales}`, 'x-weavekit-on-behalf-of': 'ghost' },
        body: JSON.stringify(initBody()),
      });
      expect(ghost.status).toBe(400);

      // ── 6. rate limit: separate flood key sends max+1 → isError
      const flood = await newClient(baseUrl, AGENT_KEYS.flood, 'alice');
      clients.push(flood);
      for (let i = 0; i < 100; i++) {
        await flood.client.callTool({ name: 'search_records', arguments: { object: 'lead' } });
      }
      const limited = await flood.client.callTool({ name: 'search_records', arguments: { object: 'lead' } });
      expect(limited.isError).toBe(true);
      expect(textOf(limited)).toContain('rate limit');

      // ── 8. introspection: list_objects/describe_object per identity (before engine.close)
      const emma2 = await newClient(baseUrl, AGENT_KEYS.finance, 'emma');
      clients.push(emma2);
      const list = await emma2.client.callTool({ name: 'list_objects', arguments: {} });
      const listText = JSON.parse(textOf(list));
      expect(listText.objects.map((o: { name: string }) => o.name)).toContain('lead');

      const desc = await emma2.client.callTool({ name: 'describe_object', arguments: { name: 'lead' } });
      const descText = JSON.parse(textOf(desc));
      expect(descText.fields.map((f: { name: string }) => f.name)).toContain('name');
      expect(descText.fields.map((f: { name: string }) => f.name)).not.toContain('secret');
      expect(descText.permissions.create).toBe(false); // finance has no create

      await closeClients(clients);
      clients.length = 0;

      // ── 7. audit: query after engine.close() flushes buffered sink
      await engine.close();
      engine = undefined;
      const auditRows = await auditPool.query(
        `SELECT actor_id, action, object, is_error FROM weavekit_audit WHERE action LIKE 'mcp.tool.%' ORDER BY id`,
      );
      const actions = auditRows.rows.map((r: { action: string }) => r.action);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions).toContain('mcp.tool.search_records');
      expect(actions).toContain('mcp.tool.update_record');
      expect(actions).toContain('mcp.tool.get_record');
      expect(actions).toContain('mcp.tool.workflow_transition');
      // agent identity: actor_id = agentKey
      expect(auditRows.rows.some((r: { actor_id: string }) => r.actor_id === AGENT_KEYS.sales)).toBe(true);
      // denial audited as isError
      const denied = auditRows.rows.find((r: { action: string; is_error: boolean }) => r.action === 'mcp.tool.update_record' && r.is_error);
      expect(denied).toBeDefined();
    } finally {
      await closeClients(clients);
      if (engine !== undefined) {
        try {
          await engine.close();
        } catch {
          // already closed / pool ended
        }
      }
      try {
        await auditPool.query('DROP TABLE IF EXISTS lead, ticket, weavekit_meta, weavekit_audit CASCADE');
      } catch {
        // pool already ended
      }
      await auditPool.end();
    }
  }, 60000);
});


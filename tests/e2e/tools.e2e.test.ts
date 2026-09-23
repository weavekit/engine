import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from '../helpers/test.js';
import { buildEngineFromRegistry, migrate, ObjectRegistry, type ObjectDefinition } from '../../src/index.js';
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
  ],
  permissions: {
    sales: { read: 'all', create: true, update: ['name'], delete: false },
    finance: { read: 'all' },
  },
};

const AGENT_KEYS = { sales: 'key-sales', finance: 'key-finance' };
const IDENTITIES = {
  alice: { id: 'u-alice', roles: ['sales'] },
  emma: { id: 'u-emma', roles: ['finance'] },
};

const CUSTOM_TOOL = [
  "export default {",
  "  name: 'reassign_ticket',",
  "  description: 'Reassign a ticket (custom tool e2e)',",
  "  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },",
  "  roles: ['sales'],",
  "  handler: async (ctx) => {",
  "    const rec = await ctx.dataAccess.create('lead', { id: `C-${ctx.args.name}`, name: ctx.args.name, status: 'open' }, { subject: ctx.subject });",
  "    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: rec.id }) }] };",
  "  },",
  "};",
].join('\n');

interface ClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function newClient(base: string, key: string, onBehalfOf: string): Promise<ClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: {
      headers: { authorization: `Bearer ${key}`, 'x-weavekit-on-behalf-of': onBehalfOf },
    },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

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

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r.content?.find((b) => b.type === 'text')?.text ?? '';
}

maybe('custom tools E2E (toolsDir → tools/list role filtering + tools/call controlled ctx + auto audit)', () => {
  it('register custom tool → visible per role → call persists via RBAC dataAccess → audit mcp.tool.<name>', async () => {
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    const clients: ClientHandle[] = [];
    let auditPool = await new (await import('pg')).Pool({ connectionString: url });
    let root = '';
    try {
      await auditPool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      await auditPool.end();
      auditPool = await new (await import('pg')).Pool({ connectionString: url });

      root = await mkdtemp(join(tmpdir(), 'weavekit-tools-e2e-'));
      const toolsDir = join(root, 'tools');
      await mkdir(toolsDir);
      await writeFile(join(toolsDir, 'reassign_ticket.js'), CUSTOM_TOOL);

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.buildGraph();
      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        schemaDir: root,
        auth: {
          source: {
            [AGENT_KEYS.sales]: { id: 'a-sales', roles: ['agent'] },
            [AGENT_KEYS.finance]: { id: 'a-finance', roles: ['agent'] },
          },
        },
        tools: { toolsDir: 'tools' },
        adapters: { mcp: { identities: IDENTITIES } },
        subsystems: { audit: { enabled: true } },
      });
      const { app, pool, registry, dataAccess } = engine;

      await migrate(registry, { databaseUrl: url! });
      await dataAccess.create('lead', { id: 'L1', name: 'Acme', status: 'open' }, { pool, registry });

      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // ── 1. tool surface merge: sales sees custom tool, finance does not (roles whitelist)
      const alice = await newClient(baseUrl, AGENT_KEYS.sales, 'alice');
      clients.push(alice);
      const aliceNames = (await alice.client.listTools()).tools.map((t) => t.name);
      expect(aliceNames).toContain('reassign_ticket');
      expect(aliceNames).toContain('search_records'); // registry tools coexist

      const emma = await newClient(baseUrl, AGENT_KEYS.finance, 'emma');
      clients.push(emma);
      const emmaNames = (await emma.client.listTools()).tools.map((t) => t.name);
      expect(emmaNames).not.toContain('reassign_ticket');

      // ── 2. call: sales creates record through controlled ctx.dataAccess
      const call = await alice.client.callTool({ name: 'reassign_ticket', arguments: { name: 'Acme2' } });
      expect(call.isError).toBeUndefined(); // success no isError
      const parsed = JSON.parse(textOf(call));
      expect(parsed.ok).toBe(true);

      // ── 3. denied role call rejected (call-level enforcement, outside tool surface)
      let denied: Error | undefined;
      try {
        await emma.client.callTool({ name: 'reassign_ticket', arguments: { name: 'X' } });
      } catch (e) {
        denied = e as Error;
      }
      expect(denied).toBeDefined();
      expect(denied!.message).toContain('reassign_ticket');

      // ── 4. persistence verification (via RBAC dataAccess, creator is sales)
      const rows = await pool.query(`SELECT id, name FROM lead WHERE id = 'C-Acme2'`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ id: 'C-Acme2', name: 'Acme2' });

      await closeClients(clients);
      clients.length = 0;

      // ── 5. audit: mcp.tool.reassign_ticket (actorId = agentKey)
      await engine.close();
      engine = undefined;
      const auditRows = await auditPool.query(
        `SELECT actor_id, action, is_error FROM weavekit_audit WHERE action = 'mcp.tool.reassign_ticket'`,
      );
      expect(auditRows.rows.length).toBeGreaterThan(0);
      const ok = auditRows.rows.find((r: { is_error: boolean }) => !r.is_error);
      expect(ok).toBeDefined();
      expect(ok!.actor_id).toBe(AGENT_KEYS.sales);
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
        await auditPool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      } catch {
        // pool already ended
      }
      await auditPool.end();
      if (root !== '') await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from '../helpers/test.js';
import { buildEngineFromRegistry, migrate, ObjectRegistry, type ObjectDefinition, type GuardrailPolicy } from '../../src/index.js';
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
  permissions: { sales: { read: 'all', create: true, update: ['name'], delete: false } },
};

const AGENT_KEYS = { sales: 'key-sales' };
const IDENTITIES = { alice: { id: 'u-alice', roles: ['sales'] } };

const TOOL = [
  "export default {",
  "  name: 'process_ticket',",
  "  description: 'Process a ticket (policies e2e)',",
  "  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },",
  "  roles: ['sales'],",
  "  handler: async (ctx) => {",
  "    await ctx.dataAccess.create('lead', { id: `L-${ctx.args.name}`, name: ctx.args.name, status: 'open' }, { subject: ctx.subject });",
  "    return { content: [{ type: 'text', text: JSON.stringify({ email: ctx.args.email ?? 'none', name: ctx.args.name }) }] };",
  "  },",
  "};",
].join('\n');

/** one policy whose decision follows ctx.args.mode (deny / approve / mask / allow) */
const modePolicy: GuardrailPolicy = {
  name: 'mode-policy',
  decide: (ctx) => {
    const mode = (ctx.args as { mode?: string }).mode;
    if (mode === 'deny') return { allow: false, reason: 'denied by mode', errorCode: 'mcp.policy.denied' };
    if (mode === 'approve') return { allow: false, requireApproval: true, approvalKey: 'ap-e2e' };
    if (mode === 'mask') return { allow: true, mask: { email: '***' } };
    return { allow: true };
  },
};

interface ClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function newClient(base: string): Promise<ClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: {
      headers: { authorization: `Bearer ${AGENT_KEYS.sales}`, 'x-weavekit-on-behalf-of': 'alice' },
    },
  });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return r.content?.find((b) => b.type === 'text')?.text ?? '';
}

maybe('policy pipeline E2E (deny / approval pending·host approve·client retry / PII masking / audit)', () => {
  it('deny → isError; requireApproval → pending → approve → client retry allowed; mask takes effect; approval action audited', async () => {
    let engine: Awaited<ReturnType<typeof buildEngineFromRegistry>> | undefined;
    let client: ClientHandle | undefined;
    let auditPool = await new (await import('pg')).Pool({ connectionString: url });
    let root = '';
    try {
      await auditPool.query('DROP TABLE IF EXISTS lead, weavekit_meta, weavekit_audit CASCADE');
      await auditPool.end();
      auditPool = await new (await import('pg')).Pool({ connectionString: url });

      root = await mkdtemp(join(tmpdir(), 'weavekit-policies-e2e-'));
      const toolsDir = join(root, 'tools');
      await mkdir(toolsDir);
      await writeFile(join(toolsDir, 'process_ticket.js'), TOOL);

      const registry0 = new ObjectRegistry();
      registry0.register(LEAD);
      registry0.buildGraph();
      engine = await buildEngineFromRegistry(registry0, {
        databaseUrl: url!,
        schemaDir: root,
        auth: { source: { [AGENT_KEYS.sales]: { id: 'a-sales', roles: ['agent'] } } },
        tools: { toolsDir: 'tools', guardrails: { policies: [modePolicy] } },
        adapters: { mcp: { identities: IDENTITIES } },
        subsystems: { audit: { enabled: true } },
      });
      const { app, pool, registry } = engine;

      await migrate(registry, { databaseUrl: url! });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      client = await newClient(baseUrl);

      // ── 1. deny
      const denied = await client.client.callTool({ name: 'process_ticket', arguments: { name: 'D1', mode: 'deny' } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain('denied by mode');

      // ── 2. requireApproval → pending (with approvalKey), host approve → client retry allowed
      const pending = await client.client.callTool({ name: 'process_ticket', arguments: { name: 'A1', mode: 'approve' } });
      expect(pending.isError).toBe(true);
      expect(textOf(pending)).toContain('ap-e2e');

      const queue = engine.tools!.executor.approvals;
      expect(await queue.query('pending')).toHaveLength(1);
      expect(await queue.approve('ap-e2e', 'manager')).toBe(true);

      const retry = await client.client.callTool({ name: 'process_ticket', arguments: { name: 'A1', mode: 'approve' } });
      expect(retry.isError).toBeUndefined();
      const rows = await pool.query(`SELECT id FROM lead WHERE id = 'L-A1'`);
      expect(rows.rows).toHaveLength(1);

      // ── 3. mask: returned JSON top-level email replaced
      const masked = await client.client.callTool({
        name: 'process_ticket',
        arguments: { name: 'M1', mode: 'mask', email: 'a@x.com' },
      });
      const maskedText = JSON.parse(textOf(masked));
      expect(maskedText.email).toBe('***');
      expect(maskedText.name).toBe('M1');

      await client.transport.close();
      client = undefined;

      // ── 4. audit: deny/pending/success + approval action (meta.approvalKey)
      await engine.close();
      engine = undefined;
      const auditRows = await auditPool.query(
        `SELECT action, is_error, error_code, meta FROM weavekit_audit WHERE action = 'mcp.tool.process_ticket' ORDER BY id`,
      );
      expect(auditRows.rows.length).toBeGreaterThan(0);
      // deny and pending are isError
      expect(auditRows.rows.some((r: { is_error: boolean; error_code: string }) => r.is_error && r.error_code === 'mcp.policy.denied')).toBe(true);
      expect(auditRows.rows.some((r: { is_error: boolean; error_code: string }) => r.is_error && r.error_code === 'mcp.approval.pending')).toBe(true);
      // success path present
      expect(auditRows.rows.some((r: { is_error: boolean }) => !r.is_error)).toBe(true);
      // approval action audited (meta.approver = manager)
      const approval = await auditPool.query(
        `SELECT actor_id, meta FROM weavekit_audit WHERE meta->>'approver' = 'manager'`,
      );
      expect(approval.rows).toHaveLength(1);
      expect(approval.rows[0]!.actor_id).toBe('manager');
    } finally {
      try {
        await client?.transport.close();
      } catch {
        // already closed
      }
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

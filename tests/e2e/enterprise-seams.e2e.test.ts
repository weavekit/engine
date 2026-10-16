import { describe, it, before, after, expect } from '../helpers/test.js';
import {
  AUDIT_MODES,
  buildEngineFromRegistry,
  createPool,
  migrate,
  ObjectRegistry,
  type ApprovalsBackend,
  type AuditEvent,
  type AuditSink,
  type CounterStore,
  type Evidence,
  type EvidenceSink,
  type ObjectDefinition,
  type WeaveKitEngine,
} from '../../src/index.js';
import type { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const ITEM: ObjectDefinition = {
  name: 'ent_seam_item',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
  permissions: { editor: { read: 'all', create: true, update: true, delete: true } },
};

const editor = { id: '72222222-2222-2222-2222-222222222222', roles: ['editor'] };

/**
 * G1–G4: host-injected audit sink / approvals backend / counter store / evidence
 * sink (enterprise E2/E3) are actually used by the assembled engine.
 */
maybe('Enterprise seams E2E: injected audit/approvals/quota/evidence are used', () => {
  let pool: Pool;
  let engine: WeaveKitEngine;

  const auditEvents: AuditEvent[] = [];
  const evidenceRows: Evidence[] = [];
  const approvalsCalls: string[] = [];

  const auditSink: AuditSink = {
    async record(event: AuditEvent): Promise<void> {
      auditEvents.push(event);
    },
    async recordBatch(events: AuditEvent[]): Promise<void> {
      auditEvents.push(...events);
    },
    async recordInTx(event: AuditEvent): Promise<void> {
      auditEvents.push(event);
    },
  };
  const evidenceSink: EvidenceSink = {
    async record(evidence: Evidence): Promise<void> {
      evidenceRows.push(evidence);
    },
  };
  const counter: CounterStore = {
    async consume(_key, amount, limit) {
      return { allowed: amount <= limit, value: amount };
    },
    async value(): Promise<number> {
      return 5;
    },
  };
  const approvalsBackend: ApprovalsBackend = {
    async list() {
      approvalsCalls.push('list');
      return [];
    },
    async get() {
      approvalsCalls.push('get');
      return undefined;
    },
    async upsert() {
      approvalsCalls.push('upsert');
    },
    async resolve() {
      approvalsCalls.push('resolve');
      return true;
    },
    async count() {
      approvalsCalls.push('count');
      return 0;
    },
  };

  before(async () => {
    pool = createPool(url!);
    await pool.query(`DROP TABLE IF EXISTS ent_seam_item, weavekit_record__ent_seam_item CASCADE`);
    const registry = new ObjectRegistry();
    registry.register(ITEM);
    registry.buildGraph();
    await migrate(registry, { databaseUrl: url! });
    await pool.query(`DELETE FROM weavekit_evidence WHERE object = 'ent_seam_item'`);
    await pool.query(`DELETE FROM weavekit_user WHERE id::text = $1`, [editor.id]);
    await pool.query(`INSERT INTO weavekit_user (id, roles, enabled) VALUES ($1, $2::jsonb, true)`, [
      editor.id,
      JSON.stringify(editor.roles),
    ]);
    engine = await buildEngineFromRegistry(registry, {
      databaseUrl: url!,
      auth: { source: { 'key-editor': editor } },
      subsystems: { audit: { enabled: true, mode: AUDIT_MODES.TRANSACTIONAL, sink: auditSink } },
      tools: { approvals: { backend: approvalsBackend } },
      quotas: { store: counter },
      evidence: { sink: evidenceSink },
    });
  });

  after(async () => {
    await engine?.close();
    await pool?.end();
  });

  const dctx = {
    get pool() {
      return engine.pool;
    },
    get registry() {
      return engine.registry;
    },
    principal: { kind: 'user' as const, subject: editor },
  };

  it('routes audit through the injected in-transaction sink and evidence to the injected sink', async () => {
    await engine.dataAccess.create('ent_seam_item', { id: 'S1', title: 'a' }, dctx);
    expect(
      auditEvents.some((e) => e.action === 'create' && e.objectName === 'ent_seam_item'),
    ).toBe(true);
    expect(evidenceRows.some((e) => e.plan.action === 'object.ent_seam_item.create')).toBe(true);
  });

  it('exposes the injected counter store and uses the injected approvals backend', async () => {
    expect(engine.quotas).toBe(counter);
    await engine.approvals!.list();
    expect(approvalsCalls).toContain('list');
  });
});

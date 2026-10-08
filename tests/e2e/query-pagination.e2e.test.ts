import { describe, it, expect } from '../helpers/test.js';
import { ObjectRegistry, SchemaError, createPool, migrate } from '../../src/core/index.js';
import { createAudit } from '../../src/subsystems/audit/index.js';
import { queryAudit } from '../../src/subsystems/audit/store.js';
import { insertEvidence, queryEvidence } from '../../src/subsystems/evidence/index.js';
import type { AuditEvent } from '../../src/core/audit/index.js';
import type { Evidence } from '../../src/core/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const AUDIT_ACTION = 'test.cursor.audit';
const EVIDENCE_ACTION = 'test.cursor.evidence';

const auditEvent = (n: number): AuditEvent => ({
  actorType: 'user',
  actorId: 'u1',
  action: AUDIT_ACTION,
  objectName: 'thing',
  objectId: `#${n}`,
  timestamp: new Date(),
});

const evidence = (n: number): Evidence => ({
  actor: { key: 'a1', label: 'agent' },
  plan: { action: EVIDENCE_ACTION, objectName: 'thing', objectId: `#${n}`, args: { n } },
  stages: [{ stage: 'plan', outcome: 'ok', at: new Date() }],
  isError: false,
  timestamp: new Date(),
});

/** audit + evidence expose the same stable keyset-cursor pagination contract */
maybe('audit / evidence pagination (keyset cursor)', () => {
  it('paginates newest-first without overlap and rejects a bad cursor', async () => {
    const pool = createPool(url!);
    try {
      const reg = new ObjectRegistry();
      reg.buildGraph();
      await migrate(reg, { databaseUrl: url! }); // provisions weavekit_evidence
      const audit = await createAudit(pool);

      // 5 audit events + 5 evidence rows
      for (let i = 0; i < 5; i += 1) await audit.record(auditEvent(i));
      for (let i = 0; i < 5; i += 1) await insertEvidence(pool, evidence(i));

      // ---- audit ----
      const page1 = await queryAudit(pool, { action: AUDIT_ACTION, limit: 2 });
      expect(page1.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await queryAudit(pool, { action: AUDIT_ACTION, limit: 2, cursor: page1.nextCursor! });
      const page3 = await queryAudit(pool, { action: AUDIT_ACTION, limit: 2, cursor: page2.nextCursor! });
      expect(page3.nextCursor).toBeUndefined(); // last page is partial
      const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((e) => e.objectId);
      expect(new Set(ids).size).toBe(5); // no overlap / no gap

      // a malformed cursor is a 400-class error, not a silent full scan
      let bad: unknown;
      try {
        await queryAudit(pool, { action: AUDIT_ACTION, cursor: 'not-a-cursor' });
      } catch (error) {
        bad = error;
      }
      expect(bad).toBeInstanceOf(SchemaError);
      expect((bad as SchemaError).code).toBe('http.param.invalid');

      // ---- evidence ----
      const ev1 = await queryEvidence(pool, { action: EVIDENCE_ACTION, limit: 2 });
      expect(ev1.total).toBe(5);
      expect(ev1.rows).toHaveLength(2);
      expect(ev1.nextCursor).toBeDefined();
      const ev2 = await queryEvidence(pool, { action: EVIDENCE_ACTION, limit: 2, cursor: ev1.nextCursor! });
      const ev3 = await queryEvidence(pool, { action: EVIDENCE_ACTION, limit: 2, cursor: ev2.nextCursor! });
      const evIds = [...ev1.rows, ...ev2.rows, ...ev3.rows].map((e) => e.plan.objectId);
      expect(new Set(evIds).size).toBe(5);
      expect(ev1.rows[0]?.actor.key).toBe('a1');
      expect(ev1.rows[0]?.plan.action).toBe(EVIDENCE_ACTION);
    } finally {
      await pool.query('DELETE FROM weavekit_audit WHERE action = $1', [AUDIT_ACTION]);
      await pool.query('DELETE FROM weavekit_evidence WHERE action = $1', [EVIDENCE_ACTION]);
      await pool.end();
    }
  }, 60000);
});

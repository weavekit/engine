import { describe, it, expect } from '../helpers/test.js';
import { createPool, defineObject } from '../../src/core/index.js';
import { recordKeySql } from '../../src/core/storage/record-key-sql.js';
import { encodeRecordKey } from '../../src/core/object/record-key.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

const q = (id: string) => `"${id}"`;

maybe('record_key SQL⇄JS contract E2E (local PG)', () => {
  it('SQL recordKeySql equals the JS encoder for every type (incl. microseconds)', async () => {
    const pool = createPool(url!);
    try {
      await pool.query('DROP TABLE IF EXISTS wk_rk_fixture CASCADE');
      await pool.query(`CREATE TABLE wk_rk_fixture (
        ts        timestamptz,
        ts_naive  timestamp,
        d         date,
        t         time,
        n         numeric(20,6),
        i         integer,
        s         varchar(255),
        u         uuid
      )`);
      await pool.query(
        `INSERT INTO wk_rk_fixture (ts, ts_naive, d, t, n, i, s, u)
         VALUES ('2026-09-26T10:30:00.123456Z', '2026-09-26T10:30:00.123456', '2026-09-26',
                 '10:30:00.123456', 123.45, 7, '订单:1', '11111111-1111-1111-1111-111111111111'),
                ('2026-09-26T10:30:00.123457Z', '2026-09-26T10:30:00.123456', '2026-09-26',
                 '10:30:00.123456', 123.45, 7, '订单:1', '11111111-1111-1111-1111-111111111111')`,
      );

      const cases: Array<{ type: string; col: string; expected: string }> = [
        { type: 'timestamptz', col: 'ts', expected: '2026-09-26T10:30:00.123456Z' },
        { type: 'timestamp', col: 'ts_naive', expected: '2026-09-26T10:30:00.123456' },
        { type: 'date', col: 'd', expected: '2026-09-26' },
        { type: 'time', col: 't', expected: '10:30:00.123456' },
        { type: 'number', col: 'n', expected: '123.450000' },
        { type: 'integer', col: 'i', expected: '7' },
        { type: 'string', col: 's', expected: '订单:1' },
        { type: 'uuid', col: 'u', expected: '11111111-1111-1111-1111-111111111111' },
      ];

      for (const c of cases) {
        const def = defineObject({ name: 'fixture', fields: [{ name: c.col, type: c.type, primary: true }] });
        const sql = `SELECT ${recordKeySql(def, (n) => q(n))} AS k FROM wk_rk_fixture ORDER BY ts LIMIT 1`;
        const res = await pool.query(sql);
        expect(res.rows[0]!.k).toBe(encodeRecordKey([c.expected]));
      }

      // microseconds are preserved + distinct (the two rows differ only in µs)
      const tsDef = defineObject({ name: 'fixture', fields: [{ name: 'ts', type: 'timestamptz', primary: true }] });
      const keys = await pool.query(
        `SELECT ${recordKeySql(tsDef, (n) => q(n))} AS k FROM wk_rk_fixture ORDER BY ts`,
      );
      expect(keys.rows[0]!.k).not.toBe(keys.rows[1]!.k);
      expect(String(keys.rows[0]!.k)).toContain('.123456Z');

      // composite: SQL concat equals JS encode of the canonical tuple
      const comp = defineObject({
        name: 'fixture',
        fields: [
          { name: 's', type: 'string', primary: true },
          { name: 'i', type: 'integer', primary: true },
        ],
      });
      const compRes = await pool.query(
        `SELECT ${recordKeySql(comp, (n) => q(n))} AS k FROM wk_rk_fixture ORDER BY ts LIMIT 1`,
      );
      expect(compRes.rows[0]!.k).toBe(encodeRecordKey(['订单:1', '7']));
    } finally {
      await pool.query('DROP TABLE IF EXISTS wk_rk_fixture CASCADE');
      await pool.end();
    }
  });
});

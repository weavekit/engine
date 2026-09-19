import { describe, it, expect } from '../helpers/test.js';import { createPool } from '../../src/core/index.js';

const url = process.env.DATABASE_URL;
const maybe = url !== undefined ? describe : describe.skip;

maybe('Database connection E2E', () => {
  it('valid connection string can query successfully', async () => {
    const pool = createPool(url!);
    try {
      const res = await pool.query('SELECT 1 AS ok');
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('invalid connection string fails to connect', async () => {
    const pool = createPool('postgres://postgres:wrong@localhost:5432/weavekit_test');
    try {
      let failed = false;
      try {
        await pool.query('SELECT 1');
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

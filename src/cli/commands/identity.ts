import { createPool } from '../../core/index.js';
import { PgIdentityStore, resolveIdentitySource, runIdentitySync } from '../../runtime/identity/index.js';
import { loadConfig } from '../load-config.js';
import type { IdentitySyncOptions } from '../types/index.js';

/**
 * `weave sync:identity` — pull the configured identity source and provision it
 * into the engine-owned directory (`weavekit_user` / `weavekit_department`).
 * Read-only against the customer's own tables. Run this before the engine
 * serves scoped (own/department) access.
 */
export async function identitySync(cwd: string, options: IdentitySyncOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const identity = config.identity;
  if (identity?.source === undefined) {
    throw new Error('no identity.source configured in weavekit.config.ts');
  }
  const url = config.databaseUrl ?? process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set');

  const pool = createPool(url);
  try {
    const source = resolveIdentitySource(identity.source, pool);
    const store = identity.store ?? new PgIdentityStore(pool);
    const summary = await runIdentitySync(source, store, {
      dryRun: options.dryRun === true,
      deactivateMissing: identity.sync?.deactivateMissing,
    });

    p.table([
      ['kind', 'created', 'updated', 'disabled'],
      ['users', String(summary.users.created), String(summary.users.updated), String(summary.users.disabled)],
      [
        'departments',
        String(summary.departments.created),
        String(summary.departments.updated),
        String(summary.departments.disabled),
      ],
    ]);
    for (const warning of summary.warnings) p.error(`warning: ${warning}`);
    p.kv([
      { source: summary.source },
      { 'dry-run': summary.dryRun ? 'true' : undefined },
      { cursor: summary.cursor ?? '-' },
    ]);
    p.data(summary);
  } finally {
    await pool.end();
  }
}

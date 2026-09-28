import { createPool } from '../../core/index.js';
import type { Pool } from 'pg';
import { IdentityAdmin, PgIdentityStore, resolveIdentitySource, runIdentitySync } from '../../runtime/identity/index.js';
import { loadConfig } from '../load-config.js';
import type {
  IdentityCreateOptions,
  IdentityListOptions,
  IdentitySyncOptions,
  IdentityToggleOptions,
} from '../types/index.js';

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

/** open a pool + greenfield identity admin from the project config */
async function openAdmin(cwd: string): Promise<{ admin: IdentityAdmin; pool: Pool }> {
  const config = await loadConfig(cwd);
  const url = config.databaseUrl ?? process.env.DATABASE_URL;
  if (url === undefined) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  const store = config.identity?.store ?? new PgIdentityStore(pool);
  return { admin: new IdentityAdmin(store), pool };
}

function parseRoles(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `weave identity:list` — list engine-owned users (greenfield admin) */
export async function identityList(cwd: string, options: IdentityListOptions): Promise<void> {
  const { admin, pool } = await openAdmin(cwd);
  try {
    const users = await admin.list();
    options.printer.table([
      ['id', 'roles', 'departmentId', 'enabled'],
      ...users.map((u) => [u.id, u.roles.join(','), u.departmentId ?? '-', String(u.enabled ?? '')]),
    ]);
    options.printer.data(users);
  } finally {
    await pool.end();
  }
}

/** `weave identity:create <name>` — create an engine-owned user */
export async function identityCreate(cwd: string, options: IdentityCreateOptions): Promise<void> {
  const { admin, pool } = await openAdmin(cwd);
  try {
    const { id } = await admin.create({
      name: options.name,
      email: options.email ?? null,
      roles: parseRoles(options.roles) ?? [],
      enabled: options.disabled !== true,
    });
    options.printer.log(`created identity ${id}`);
    options.printer.data({ id });
  } finally {
    await pool.end();
  }
}

/** `weave identity:enable <id>` / `weave identity:disable <id>` */
export async function identityToggle(
  cwd: string,
  options: IdentityToggleOptions,
  enabled: boolean,
): Promise<void> {
  const { admin, pool } = await openAdmin(cwd);
  try {
    const ok = await admin.setEnabled(options.id, enabled);
    if (!ok) throw new Error(`identity "${options.id}" not found`);
    options.printer.log(`${enabled ? 'enabled' : 'disabled'} identity ${options.id}`);
    options.printer.data({ id: options.id, enabled });
  } finally {
    await pool.end();
  }
}

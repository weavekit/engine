import type { Pool } from 'pg';
import type { IdentitySource } from '../../core/provider/identity/index.js';
import { createPgIdentitySource, type PgIdentitySourceConfig } from './sources/pg.js';

/**
 * Turn a configured identity source into an {@link IdentitySource}: either it
 * already is one (has `pull`), or it is a declarative `pg` descriptor. Keeps
 * config ergonomic without a global source registry.
 */
export function resolveIdentitySource(
  source: IdentitySource | PgIdentitySourceConfig,
  pool: Pool,
): IdentitySource {
  if (typeof (source as IdentitySource).pull === 'function') return source as IdentitySource;
  return createPgIdentitySource(source as PgIdentitySourceConfig, pool);
}

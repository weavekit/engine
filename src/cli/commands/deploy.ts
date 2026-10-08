import { syncSchema } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { DeployApplyOptions, DeployPlanOptions } from '../types/index.js';

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
type RiskLevel = typeof RISK_LEVELS[keyof typeof RISK_LEVELS];

/** coarse risk heuristic over the generated DDL (a drop is the only high-risk shape today) */
function riskOf(statements: readonly string[]): RiskLevel {
  if (statements.some((s) => /\bDROP\s+TABLE\b/i.test(s))) return RISK_LEVELS.HIGH;
  if (statements.some((s) => /\bALTER\s+TABLE\b/i.test(s) || /\bALTER\s+TYPE\b/i.test(s))) return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.LOW;
}

async function loadSyncOptions(cwd: string, dryRun: boolean) {
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const fieldTypes = await resolveProjectFieldTypes(cwd, config);
  // RLS for db.query is on whenever the script subsystem is enabled (default role weavekit_query)
  const rlsRole = config.subsystems?.script?.enabled
    ? config.subsystems.script.sandbox?.rls?.role ?? 'weavekit_query'
    : undefined;
  return {
    dir: schemaDir,
    databaseUrl: config.migrationDatabaseUrl ?? config.databaseUrl,
    dryRun,
    rls: rlsRole !== undefined ? { role: rlsRole } : undefined,
    allowedFieldTypes: config.features?.fieldTypes,
    fieldTypes,
  } as const;
}

/** `weave deploy plan` — preview the schema/DB changes for the next deploy (read-only) */
export async function deployPlan(cwd: string, options: DeployPlanOptions): Promise<void> {
  const p = options.printer;
  const result = await syncSchema(await loadSyncOptions(cwd, true));
  const statements = result.migration.statements;
  const risk = riskOf(statements);
  p.table([['object', 'status'], ...result.files.map((f) => [
    f.name,
    result.migration.applied.includes(f.name) ? 'pending' : 'no-change',
  ])]);
  p.kv([
    { objects: result.files.length },
    { 'schema hash': result.schemaHash.slice(0, 12) },
    { 'ddl statements': statements.length },
    { risk },
  ]);
  if (statements.length > 0) {
    p.log('planned DDL:');
    for (const s of statements) p.log(`  ${s}`);
  } else {
    p.log('already in sync — no changes');
  }
  p.data({
    objects: result.files.map((f) => f.name),
    statements,
    schemaHash: result.schemaHash,
    risk,
  });
}

/** `weave deploy apply` — apply the changes atomically and record a schema revision */
export async function deployApply(cwd: string, options: DeployApplyOptions): Promise<void> {
  const p = options.printer;
  const result = await syncSchema(await loadSyncOptions(cwd, false));
  p.kv([
    { objects: result.files.length },
    { 'ddl statements': result.migration.statements.length },
    { 'cache updated': result.cache.updated.join(', ') || '-' },
    { 'cache removed': result.cache.removed.join(', ') || '-' },
    { revision: result.revision === undefined ? '-' : `${result.revision.revision}${result.revision.created ? '' : ' (unchanged)'}` },
    { 'schema hash': result.schemaHash.slice(0, 12) },
  ]);
  for (const warning of result.migration.warnings) p.error(`warning: ${warning}`);
  p.data({
    objects: result.files.map((f) => f.name),
    statements: result.migration.statements,
    applied: result.migration.applied,
    cache: result.cache,
    schemaHash: result.schemaHash,
    revision: result.revision ?? null,
  });
}

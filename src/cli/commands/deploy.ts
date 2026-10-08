import { analyzeImpact, createPool, type ObjectDefinition, type SchemaImpact } from '../../core/index.js';
import { syncSchema } from '../../runtime/git/index.js';
import { latestSchemaRevision, type SchemaRevision } from '../../runtime/metadata/index.js';
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

/** latest recorded schema revision (null when none / no DB) — the deploy drift anchor */
async function readRevision(databaseUrl: string | undefined): Promise<SchemaRevision | null> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (url === undefined) return null;
  const pool = createPool(url);
  try {
    return await latestSchemaRevision(pool);
  } finally {
    await pool.end();
  }
}

function renderImpact(p: DeployPlanOptions['printer'], impact: SchemaImpact): void {
  p.kv([
    { 'new tables': impact.creates.length || undefined, 'columns added': impact.columnAdds.length || undefined },
    { constraints: impact.constraints.length || undefined, indexes: impact.indexes.length || undefined },
    { 'enum changes': impact.enumChanges.length || undefined, 'rls changes': impact.rlsChanges.length || undefined },
    { 'data-compat risk': impact.dataCompat.risk, 'api breaking': impact.apiBreaking },
  ]);
  for (const note of impact.dataCompat.notes) p.log(`  ! ${note}`);
  if (impact.rbacTenant.tenantObjects.length > 0) {
    p.log(`  tenant-scoped: ${impact.rbacTenant.tenantObjects.join(', ')}`);
  }
  if (impact.rbacTenant.permissionObjects.length > 0) {
    p.log(`  permissioned: ${impact.rbacTenant.permissionObjects.join(', ')}`);
  }
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
  const syncOptions = await loadSyncOptions(cwd, true);
  const result = await syncSchema(syncOptions);
  const statements = result.migration.statements;
  const risk = riskOf(statements);

  const changedDefs = result.migration.applied
    .map((name) => result.registry.get(name))
    .filter((def): def is ObjectDefinition => def !== undefined);
  const impact = analyzeImpact(statements, changedDefs);

  const revision = await readRevision(syncOptions.databaseUrl);
  const configDrift = revision !== null && revision.contentHash !== result.schemaHash;

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

  p.log('');
  p.log('impact:');
  renderImpact(p, impact);

  p.log('');
  p.kv([
    { 'live revision': revision === null ? '-' : revision.revision },
    { 'revision hash': revision === null ? '-' : revision.contentHash.slice(0, 12) },
    { 'source commit': revision?.sourceCommit ?? '-' },
    { 'config drift': configDrift ? 'yes — on-disk schema differs from the last applied revision' : 'no' },
  ]);

  if (statements.length > 0) {
    p.log('');
    p.log('planned DDL:');
    for (const s of statements) p.log(`  ${s}`);
  } else {
    p.log('');
    p.log('already in sync — no changes');
  }
  p.data({
    objects: result.files.map((f) => f.name),
    statements,
    schemaHash: result.schemaHash,
    risk,
    impact,
    revision: revision === null ? null : {
      revision: revision.revision,
      contentHash: revision.contentHash,
      sourceCommit: revision.sourceCommit,
      actor: revision.actor,
      createdAt: revision.createdAt,
    },
    configDrift,
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

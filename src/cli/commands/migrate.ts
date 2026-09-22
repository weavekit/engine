import { createPool } from '../../core/index.js';
import {
  autoCommit,
  buildCommitMessage,
  diffMetadata,
  gitCommitAuthor,
  recordSchemaChanges,
  syncSchema,
  type AutoCommitResult,
} from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { MigrateOptions } from '../types/index.js';

/** `weave migrate` — Git → PG one-way sync, then auto-commit the metadata tree */
export async function migrate(cwd: string, options: MigrateOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const fieldTypes = await resolveProjectFieldTypes(cwd, config);
  // RLS for db.query is on whenever the script subsystem is enabled (default role weavekit_query)
  const rlsRole = config.subsystems?.script?.enabled
    ? config.subsystems.script.sandbox?.rls?.role ?? 'weavekit_query'
    : undefined;

  const result = await syncSchema({
    dir: schemaDir,
    databaseUrl: config.databaseUrl,
    dryRun: options.dryRun,
    rls: rlsRole !== undefined ? { role: rlsRole } : undefined,
    allowedFieldTypes: config.features?.fieldTypes,
    fieldTypes,
  });

  const changes = options.dryRun ? [] : await diffMetadata(schemaDir, result.files);

  const applied = new Set(result.migration.applied);
  const rows: string[][] = [['object', 'status']];
  for (const file of result.files) {
    const status = options.dryRun ? (applied.has(file.name) ? 'pending' : 'no-change') : applied.has(file.name) ? 'applied' : 'in-sync';
    rows.push([file.name, status]);
  }
  p.table(rows);
  p.kv([
    { objects: result.files.length },
    { 'ddl statements': result.migration.statements.length },
    { 'dry-run': options.dryRun ? 'true' : undefined },
    { 'cache updated': result.cache.updated.join(', ') || '-' },
    { 'cache removed': result.cache.removed.join(', ') || '-' },
  ]);

  let commit: AutoCommitResult | undefined;
  if (!options.dryRun) {
    commit = await autoCommit({ dir: schemaDir, message: buildCommitMessage(changes) });
    if (commit.committed) {
      p.log(`committed ${commit.sha}`);
    } else {
      p.log('no metadata changes to commit');
    }
  }
  for (const warning of result.migration.warnings ?? []) {
    p.error(`warning: ${warning}`);
  }
  p.data({
    objects: result.files.map((f) => f.name),
    statements: result.migration.statements,
    applied: result.migration.applied,
    dryRun: options.dryRun === true,
    warnings: result.migration.warnings ?? [],
    cache: result.cache,
    commitSha: commit?.sha ?? null,
  });

  // queryable schema-change audit (schema.changed in weavekit_audit) — after
  // the commit so the event can carry the sha + author
  if (!options.dryRun && changes.length > 0 && commit?.committed === true) {
    const author = await gitCommitAuthor(schemaDir);
    // reached only after a successful sync, which required a DB URL
    const pool = createPool(config.databaseUrl ?? process.env.DATABASE_URL!);
    try {
      await recordSchemaChanges(pool, changes, result.files, {
        sha: commit.sha,
        author,
        applied: result.migration.applied,
      });
    } finally {
      await pool.end();
    }
  }
}

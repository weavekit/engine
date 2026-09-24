import { createPool } from '../../core/index.js';
import {
  gitCommitAuthor,
  loadSchemaDir,
  recordWorkflowMigration,
} from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { WorkflowMigrateOptions } from '../types/index.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const q = (id: string) => `"${id}"`;

interface RemapResult {
  from: string;
  to: string;
  rows: number;
}

/**
 * `weave workflow:migrate <object> [--dry-run]` — apply the object's declared
 * `workflow.json` `migrations` remaps to existing records in PostgreSQL
 * (`UPDATE <table> SET <stateField> = to WHERE <stateField> = from`). Reports
 * every remaining orphan state (a value not declared in `states` and not covered
 * by a remap) as a warning. Applying writes a system-actor `workflow.migrated`
 * audit event. Idempotent (a second run moves nothing).
 */
export async function workflowMigrate(
  cwd: string,
  object: string,
  options: WorkflowMigrateOptions,
): Promise<void> {
  const p = options.printer;
  if (!SNAKE_CASE.test(object)) {
    p.error(`object name must be snake_case: "${object}"`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const fieldTypes = await resolveProjectFieldTypes(cwd, config);
  const { registry } = await loadSchemaDir(schemaDir, {
    locale: config.locale,
    allowedFieldTypes: config.features?.fieldTypes,
    fieldTypes,
  });
  const def = registry.get(object);
  if (def === undefined) {
    p.error(`object "${object}" not found under ${schemaDir}/objects`);
    process.exitCode = 1;
    return;
  }
  const wf = def.workflow;
  if (wf === undefined) {
    p.error(`object "${object}" has no active workflow (run \`weave workflow:open ${object}\`)`);
    process.exitCode = 1;
    return;
  }

  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    p.error('no database URL (set DATABASE_URL or config.databaseUrl)');
    process.exitCode = 1;
    return;
  }

  const pool = createPool(databaseUrl);
  try {
    let counts: Array<{ state: string; rows: number }>;
    try {
      const res = await pool.query(
        `SELECT ${q(wf.stateField)} AS state, count(*)::int AS rows FROM ${q(def.name)} GROUP BY 1`,
      );
      counts = (res.rows as Array<{ state: string | null; rows: number }>).map((row) => ({
        state: row.state ?? '(null)',
        rows: row.rows,
      }));
    } catch (error) {
      p.error(
        `cannot read ${def.name}: ${error instanceof Error ? error.message : String(error)} (run \`weave migrate\` first)`,
      );
      process.exitCode = 1;
      return;
    }

    const migrations = wf.migrations ?? [];
    const remapped: RemapResult[] = [];
    for (const migration of migrations) {
      if (options.dryRun === true) {
        const rows = counts.find((c) => c.state === migration.from)?.rows ?? 0;
        remapped.push({ from: migration.from, to: migration.to, rows });
      } else {
        const res = await pool.query(
          `UPDATE ${q(def.name)} SET ${q(wf.stateField)} = $1 WHERE ${q(wf.stateField)} = $2`,
          [migration.to, migration.from],
        );
        remapped.push({ from: migration.from, to: migration.to, rows: res.rowCount ?? 0 });
      }
    }

    const liveStates = new Set(wf.states.map((s) => s.name));
    const covered = new Set(migrations.map((m) => m.from));
    const orphans = counts.filter((c) => !liveStates.has(c.state) && !covered.has(c.state));

    if (options.dryRun !== true && remapped.some((r) => r.rows > 0)) {
      const author = await gitCommitAuthor(schemaDir);
      await recordWorkflowMigration(
        pool,
        [
          {
            object: def.name,
            stateField: wf.stateField,
            ...(wf.version === undefined ? {} : { version: wf.version }),
            ...(def.workflowHash === undefined ? {} : { hash: def.workflowHash }),
            moved: remapped.filter((r) => r.rows > 0),
          },
        ],
        { author },
      );
    }

    if (remapped.length === 0 && orphans.length === 0) {
      p.log(`object "${object}": no migrations declared and no orphan states — nothing to do`);
    } else if (options.dryRun === true) {
      for (const r of remapped) p.log(`would move ${r.rows} record(s): ${r.from} → ${r.to}`);
      if (remapped.length === 0) p.log(`object "${object}": no migrations declared`);
    } else {
      for (const r of remapped) p.log(`moved ${r.rows} record(s): ${r.from} → ${r.to}`);
    }
    for (const orphan of orphans) {
      p.error(
        `warning: ${orphan.rows} record(s) in state "${orphan.state}" are not declared and not covered by a migration`,
      );
    }

    p.data({
      object: def.name,
      stateField: wf.stateField,
      workflowVersion: wf.version ?? null,
      workflowHash: def.workflowHash ?? null,
      dryRun: options.dryRun === true,
      remapped,
      orphans,
    });
  } finally {
    await pool.end();
  }
}

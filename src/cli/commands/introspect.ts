import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, inspectSchema, mapToSchema, SCHEMA_FORMAT_VERSION } from '../../core/index.js';
import { autoCommit, type AutoCommitResult } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { IntrospectOptions } from '../types/index.js';

/** split a comma-separated option into a trimmed list (undefined when empty) */
function splitCsv(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * `weave introspect` — reverse-model an existing PostgreSQL schema into
 * `objects/<table>/schema.json` (read-only; generated objects default to
 * `alter: false`, so nothing on the live database is ever changed).
 */
export async function introspect(cwd: string, options: IntrospectOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    p.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const outDir = options.out === undefined ? join(schemaDir, 'objects') : join(cwd, options.out);
  const pool = createPool(databaseUrl);
  try {
    const actual = await inspectSchema(pool, { detail: true });
    const report = mapToSchema(actual, { include: splitCsv(options.include), exclude: splitCsv(options.exclude) });

    const rows: string[][] = [['object', 'table', 'fields']];
    for (const obj of report.objects) rows.push([obj.name, obj.table, String(obj.schema.fields.length)]);
    p.table(rows);
    p.kv([
      { objects: report.objects.length },
      { skipped: report.skipped.length },
      { warnings: report.warnings.length },
      { 'dry-run': options.dryRun === true },
    ]);
    for (const s of report.skipped) p.log(`skip ${s.table}: ${s.reason}`);
    for (const w of report.warnings) p.error(`warning: ${w}`);
    for (const s of report.suggestions) p.log(`suggestion: ${s}`);

    if (options.dryRun === true) {
      p.data({
        objects: report.objects.map((o) => o.name),
        skipped: report.skipped,
        warnings: report.warnings,
        suggestions: report.suggestions,
        dryRun: true,
      });
      return;
    }

    let written = 0;
    const kept: string[] = [];
    for (const obj of report.objects) {
      const file = join(outDir, obj.name, 'schema.json');
      if (options.force !== true) {
        let exists = false;
        try {
          await readFile(file, 'utf8');
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) {
          kept.push(obj.name);
          continue;
        }
      }
      await mkdir(join(outDir, obj.name), { recursive: true });
      await writeFile(file, `${JSON.stringify({ schemaVersion: SCHEMA_FORMAT_VERSION, ...obj.schema }, null, 2)}\n`);
      written += 1;
    }
    for (const name of kept) p.log(`kept existing objects/${name}/schema.json (use --force to overwrite)`);

    let commit: AutoCommitResult | undefined;
    if (options.commit !== false) {
      commit = await autoCommit({ dir: schemaDir });
    }
    p.log(`wrote ${written} object(s)${commit?.committed === true ? ` · committed ${commit.sha}` : ''}`);

    p.data({
      objects: report.objects.map((o) => o.name),
      written,
      kept,
      skipped: report.skipped,
      warnings: report.warnings,
      suggestions: report.suggestions,
      commitSha: commit?.sha ?? null,
    });
  } finally {
    await pool.end();
  }
}

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import kleur from 'kleur';
import { migrateSchemaObject, SCHEMA_FORMAT_VERSION } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { SchemaUpgradeOptions } from '../types/index.js';

/** every `objects/<name>/schema.json` under a project root */
async function collectSchemaFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSchemaFiles(full, out);
    } else if (entry.isFile() && entry.name === 'schema.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * `weave schema:upgrade [--dry-run]` — bring every `objects/<name>/schema.json`
 * up to the current on-disk format (see `core/object/schema-version.ts`).
 * Unversioned legacy files are stamped with the current `schemaVersion`;
 * future/unsupported versions abort. Writes are explicit (`--dry-run` reports
 * only) and the change is auto-committed like every other metadata edit.
 */
export async function schemaUpgrade(cwd: string, options: SchemaUpgradeOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const objectsDir = join(schemaDir, 'objects');

  try {
    if (!(await stat(objectsDir)).isDirectory()) throw new Error('missing');
  } catch {
    p.error(`objects directory not found: ${objectsDir}`);
    process.exitCode = 1;
    return;
  }

  const files = (await collectSchemaFiles(objectsDir)).sort();
  const rows: string[][] = [['object', 'from', 'to', 'result']];
  const changed: string[] = [];

  for (const file of files) {
    const name = basename(dirname(file));
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const { object, from, migrated } = migrateSchemaObject(raw, config.locale);
    if (!migrated) {
      rows.push([name, String(from), String(SCHEMA_FORMAT_VERSION), kleur.dim('up-to-date')]);
      continue;
    }
    changed.push(file);
    if (options.dryRun !== true) {
      await writeFile(file, `${JSON.stringify(object, null, 2)}\n`);
    }
    rows.push([
      name,
      String(from),
      String(SCHEMA_FORMAT_VERSION),
      options.dryRun === true ? kleur.yellow('would upgrade') : kleur.green('upgraded'),
    ]);
  }

  if (p.json) {
    p.data({
      objects: files.map((file) => basename(dirname(file))),
      currentVersion: SCHEMA_FORMAT_VERSION,
      upgraded: changed.map((file) => basename(dirname(file))),
      dryRun: options.dryRun === true,
    });
    return;
  }

  p.table(rows);
  p.kv([
    { objects: files.length },
    { 'current version': SCHEMA_FORMAT_VERSION },
    { upgraded: changed.length || undefined },
    { 'dry-run': options.dryRun === true ? 'true' : undefined },
  ]);

  if (changed.length === 0) {
    p.log('all schema files are up to date');
    return;
  }
  if (options.dryRun === true) {
    p.log(`would upgrade ${changed.length} schema file(s)`);
    return;
  }

  const commit = await autoCommit({
    dir: schemaDir,
    message: `chore: upgrade schema.json to format v${SCHEMA_FORMAT_VERSION}`,
    identity: config.commit?.identity,
  });
  p.log(commit.committed ? `committed ${commit.sha}` : 'nothing to commit');
}

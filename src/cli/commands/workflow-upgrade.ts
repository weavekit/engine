import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import kleur from 'kleur';
import { migrateWorkflowObject } from '../../core/index.js';
import { WORKFLOW_FORMAT_VERSION } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { WorkflowUpgradeOptions } from '../types/index.js';

/** every `objects/<name>/workflow.json` under a project root */
async function collectWorkflowFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectWorkflowFiles(full, out);
    } else if (entry.isFile() && entry.name === 'workflow.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * `weave workflow:upgrade [--dry-run]` — bring every `objects/<name>/workflow.json`
 * up to the current on-disk format (see `core/object/workflow-migrations.ts`).
 * Unversioned files are stamped with the current `schemaVersion`; future/unsupported
 * versions abort. Writes are explicit (`--dry-run` reports only) and auto-committed.
 * Independent of `weave schema:upgrade`, which never touches `workflow.json`.
 */
export async function workflowUpgrade(
  cwd: string,
  options: WorkflowUpgradeOptions,
): Promise<void> {
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

  const files = (await collectWorkflowFiles(objectsDir)).sort();
  const rows: string[][] = [['object', 'from', 'to', 'result']];
  const changed: string[] = [];

  for (const file of files) {
    const name = basename(dirname(file));
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('workflow.json must be a JSON object');
      }
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      p.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    const { workflow, from, migrated } = migrateWorkflowObject(raw, config.locale);
    if (!migrated) {
      rows.push([name, String(from), String(WORKFLOW_FORMAT_VERSION), kleur.dim('up-to-date')]);
      continue;
    }
    changed.push(file);
    if (options.dryRun !== true) {
      await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`);
    }
    rows.push([
      name,
      String(from),
      String(WORKFLOW_FORMAT_VERSION),
      options.dryRun === true ? kleur.yellow('would upgrade') : kleur.green('upgraded'),
    ]);
  }

  if (p.json) {
    p.data({
      objects: files.map((file) => basename(dirname(file))),
      currentVersion: WORKFLOW_FORMAT_VERSION,
      upgraded: changed.map((file) => basename(dirname(file))),
      dryRun: options.dryRun === true,
    });
    return;
  }

  p.table(rows);
  p.kv([
    { objects: files.length },
    { 'current version': WORKFLOW_FORMAT_VERSION },
    { upgraded: changed.length || undefined },
    { 'dry-run': options.dryRun === true ? 'true' : undefined },
  ]);

  if (changed.length === 0) {
    p.log('all workflow files are up to date');
    return;
  }
  if (options.dryRun === true) {
    p.log(`would upgrade ${changed.length} workflow file(s)`);
    return;
  }

  const commit = await autoCommit({
    dir: schemaDir,
    message: `chore: upgrade workflow.json to format v${WORKFLOW_FORMAT_VERSION}`,
    identity: config.commit?.identity,
  });
  p.log(commit.committed ? `committed ${commit.sha}` : 'nothing to commit');
}

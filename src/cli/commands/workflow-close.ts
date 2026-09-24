import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { WorkflowCloseOptions } from '../types/index.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `weave workflow:close <object>` — disable the object's workflow by writing
 * `workflowEnabled: false`. The `workflow.json` definition and the state field's
 * data are kept, so the object can be re-opened later; the state field reverts to
 * a plain writable enum. Auto-commits.
 */
export async function workflowClose(
  cwd: string,
  object: string,
  options: WorkflowCloseOptions,
): Promise<void> {
  const p = options.printer;
  if (!SNAKE_CASE.test(object)) {
    p.error(`object name must be snake_case: "${object}"`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const schemaPath = join(schemaDir, 'objects', object, 'schema.json');

  let schema: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(schemaPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('invalid');
    schema = parsed;
  } catch {
    p.error(`object "${object}" not found or invalid (${schemaPath})`);
    process.exitCode = 1;
    return;
  }

  if (schema.workflowEnabled !== true) {
    p.log(`workflow already disabled for "${object}" — nothing to do`);
    p.data({ object, enabled: false, changed: false });
    return;
  }

  const nextSchema = { ...schema, workflowEnabled: false };
  await writeFile(schemaPath, `${JSON.stringify(nextSchema, null, 2)}\n`);
  const commit = await autoCommit({ dir: schemaDir });
  p.log(`workflow disabled for "${object}"${commit.committed ? ` · committed ${commit.sha}` : ''}`);
  p.data({ object, enabled: false, changed: true, committed: commit.committed });
}

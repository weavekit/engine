import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateObject } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { WorkflowOpenOptions } from '../types/index.js';
import {
  DEFAULT_WORKFLOW_ROLES,
  buildStarterWorkflow,
  parseRoles,
  renderWorkflow,
} from './workflow-starter.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `weave workflow:open <object> [--roles a,b]` — enable the object's node-chain
 * workflow. When no `workflow.json` exists it scaffolds a starter chain (roles
 * default to `approver`). When the file exists but is disabled it flips
 * `workflowEnabled` back on unchanged. Validates the combined schema+workflow
 * before writing and auto-commits. Customer tables are never altered.
 */
export async function workflowOpen(
  cwd: string,
  object: string,
  options: WorkflowOpenOptions,
): Promise<void> {
  const p = options.printer;
  if (!SNAKE_CASE.test(object)) {
    p.error(`object name must be snake_case: "${object}"`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const objectDir = join(schemaDir, 'objects', object);
  const schemaPath = join(objectDir, 'schema.json');
  const workflowPath = join(objectDir, 'workflow.json');

  let schemaRaw: string;
  try {
    schemaRaw = await readFile(schemaPath, 'utf8');
  } catch {
    p.error(`object "${object}" not found (${schemaPath})`);
    process.exitCode = 1;
    return;
  }
  let schema: Record<string, unknown>;
  try {
    const parsed = JSON.parse(schemaRaw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.fields)) throw new Error('invalid');
    schema = parsed;
  } catch {
    p.error(`invalid schema for "${object}" (${schemaPath})`);
    process.exitCode = 1;
    return;
  }

  let workflowRaw: string | undefined;
  try {
    workflowRaw = await readFile(workflowPath, 'utf8');
  } catch {
    workflowRaw = undefined;
  }

  // already enabled → idempotent
  if (schema.workflowEnabled === true && workflowRaw !== undefined) {
    p.log(`workflow already enabled for "${object}" — nothing to do`);
    p.data({ object, enabled: true, changed: false });
    return;
  }

  const validateOptions = { nameHint: object, allowedFieldTypes: config.features?.fieldTypes };

  // definition exists but disabled → resume it unchanged (no regeneration)
  if (workflowRaw !== undefined) {
    const nextSchema = { ...schema, workflowEnabled: true };
    try {
      validateObject({ ...nextSchema, workflow: JSON.parse(workflowRaw) }, validateOptions);
    } catch (error) {
      p.error(
        `cannot enable the existing workflow.json for "${object}": ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    await writeFile(schemaPath, `${JSON.stringify(nextSchema, null, 2)}\n`);
    const commit = await autoCommit({ dir: schemaDir });
    p.log(`workflow enabled for "${object}"${commit.committed ? ` · committed ${commit.sha}` : ''}`);
    p.data({ object, enabled: true, changed: true, committed: commit.committed });
    return;
  }

  // no definition yet → build a starter
  const roles = parseRoles(options.roles) ?? [...DEFAULT_WORKFLOW_ROLES];
  if (roles.length === 0) {
    p.error('--roles must list at least one role');
    process.exitCode = 1;
    return;
  }
  const starter = buildStarterWorkflow(roles);
  const nextSchema = { ...schema, workflowEnabled: true };
  try {
    validateObject({ ...nextSchema, workflow: starter }, validateOptions);
  } catch (error) {
    p.error(
      `invalid workflow for "${object}": ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  await writeFile(workflowPath, renderWorkflow(starter), { flag: 'wx' });
  await writeFile(schemaPath, `${JSON.stringify(nextSchema, null, 2)}\n`);
  const commit = await autoCommit({ dir: schemaDir });
  p.log(
    `workflow enabled for "${object}" (nodes: ${starter.nodes.map((n) => n.id).join(', ')})${commit.committed ? ` · committed ${commit.sha}` : ''}`,
  );
  p.data({
    object,
    enabled: true,
    changed: true,
    nodes: starter.nodes.map((n) => n.id),
    workflow: workflowPath,
    committed: commit.committed,
  });
}

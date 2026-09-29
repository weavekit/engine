import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, WORKFLOW_FORMAT_VERSION } from '../../core/index.js';
import type { WorkflowDefinition } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { WorkflowSwitchOptions } from '../types/index.js';
import { renderWorkflow } from './workflow-starter.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/**
 * `weave workflow:switch <object> --version <seq>` — replace
 * `objects/<object>/workflow.json` with a previously registered definition
 * revision (from `weavekit_workflow_definitions`, by `version_seq`). Affects the
 * version NEW records start under; running records keep their pinned revision.
 * Auto-commits.
 */
export async function workflowSwitch(
  cwd: string,
  object: string,
  options: WorkflowSwitchOptions,
): Promise<void> {
  const p = options.printer;
  if (!SNAKE_CASE.test(object)) {
    p.error(`object name must be snake_case: "${object}"`);
    process.exitCode = 1;
    return;
  }
  const version = options.revision === undefined ? NaN : Number(options.revision);
  if (!Number.isInteger(version) || version < 1) {
    p.error('--revision must be a positive integer');
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    p.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const pool = createPool(databaseUrl);
  try {
    const res = await pool.query(
      `SELECT definition FROM weavekit_workflow_definitions WHERE object = $1 AND version_seq = $2`,
      [object, version],
    );
    const row = res.rows[0] as { definition: WorkflowDefinition } | undefined;
    if (row === undefined) {
      p.error(`no registered workflow version ${version} for "${object}" (run \`weave migrate\` first)`);
      process.exitCode = 1;
      return;
    }
    const definition: WorkflowDefinition = {
      schemaVersion: WORKFLOW_FORMAT_VERSION,
      ...(row.definition.version === undefined ? {} : { version: row.definition.version }),
      nodes: row.definition.nodes,
    };
    const workflowPath = join(schemaDir, 'objects', object, 'workflow.json');
    await writeFile(workflowPath, renderWorkflow(definition));
    const commit = await autoCommit({ dir: schemaDir });
    p.log(
      `workflow.json for "${object}" switched to version ${version}${commit.committed ? ` · committed ${commit.sha}` : ''}`,
    );
    p.data({ object, version, workflow: workflowPath, committed: commit.committed });
  } finally {
    await pool.end();
  }
}

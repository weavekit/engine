import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIELD_TYPES, validateObject } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { WorkflowOpenOptions } from '../types/index.js';
import {
  DEFAULT_WORKFLOW_STATES,
  buildStarterWorkflow,
  parseStates,
  renderWorkflow,
  stateListError,
} from './workflow-starter.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `weave workflow:open <object> [--state-field <field>] [--states a,b,c]` —
 * enable the object's declared state machine. When no `workflow.json` exists it
 * scaffolds a starter one (plus a `status` enum field unless `--state-field`
 * reuses an existing single-valued enum). When the file exists but is disabled
 * it simply flips `workflowEnabled` back on (the definition is kept as-is).
 * Validates the combined schema+workflow before writing and auto-commits.
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
  const fields = schema.fields as Array<Record<string, unknown>>;

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

  // definition exists but disabled → resume it unchanged (no regeneration)
  if (workflowRaw !== undefined) {
    if (options.stateField !== undefined || options.states !== undefined) {
      p.error(
        `"${object}" already has workflow.json — re-enable it without --state-field/--states (delete the file to regenerate)`,
      );
      process.exitCode = 1;
      return;
    }
    const existingWorkflow = JSON.parse(workflowRaw) as { stateField?: string };
    const nextSchema = { ...schema, workflowEnabled: true };
    try {
      validateObject(
        { ...nextSchema, workflow: existingWorkflow },
        { nameHint: object, allowedFieldTypes: config.features?.fieldTypes },
      );
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
    p.data({ object, enabled: true, changed: true, stateField: existingWorkflow.stateField ?? null, committed: commit.committed });
    return;
  }

  // no definition yet → build a starter
  const explicitStates = parseStates(options.states);
  let stateField = options.stateField;
  const existing =
    stateField === undefined ? undefined : fields.find((f) => f.name === stateField);

  if (stateField !== undefined && existing === undefined) {
    p.error(
      `--state-field "${stateField}" does not exist on "${object}" (omit it to create a "status" field, or add the field first)`,
    );
    process.exitCode = 1;
    return;
  }

  let states: string[];
  let addField = false;
  if (existing !== undefined) {
    if (
      existing.type !== FIELD_TYPES.ENUM ||
      existing.multiple === true ||
      !Array.isArray(existing.options)
    ) {
      p.error(
        `--state-field "${stateField}" must be a single-valued enum field with inline options`,
      );
      process.exitCode = 1;
      return;
    }
    const enumOptions = existing.options as string[];
    states = explicitStates ?? [...enumOptions];
    const notInEnum = states.filter((s) => !enumOptions.includes(s));
    if (notInEnum.length > 0) {
      p.error(`states not in the enum options of "${stateField}": ${notInEnum.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  } else {
    stateField = 'status';
    if (fields.some((f) => f.name === stateField)) {
      p.error(
        `field "status" already exists on "${object}" — pass --state-field status to reuse it`,
      );
      process.exitCode = 1;
      return;
    }
    states = explicitStates ?? [...DEFAULT_WORKFLOW_STATES];
    addField = true;
  }

  const listError = stateListError(states);
  if (listError !== undefined) {
    p.error(`invalid states: ${listError}`);
    process.exitCode = 1;
    return;
  }
  if (stateField === undefined) {
    p.error('could not resolve a state field');
    process.exitCode = 1;
    return;
  }

  const starter = buildStarterWorkflow(stateField, states);
  const nextFields = addField
    ? [...fields, { name: stateField, type: FIELD_TYPES.ENUM, options: states }]
    : fields;
  const nextSchema = { ...schema, fields: nextFields, workflowEnabled: true };

  try {
    validateObject(
      { ...nextSchema, workflow: starter },
      { nameHint: object, allowedFieldTypes: config.features?.fieldTypes },
    );
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
    `workflow enabled for "${object}" (stateField "${stateField}", states: ${states.join(', ')})${commit.committed ? ` · committed ${commit.sha}` : ''}`,
  );
  if (addField) {
    p.log(
      `note: added the "${stateField}" field — run \`weave migrate\`, then backfill existing rows ` +
        `(e.g. UPDATE <table> SET ${stateField} = '${states[0]}' WHERE ${stateField} IS NULL)`,
    );
  }
  p.data({
    object,
    enabled: true,
    changed: true,
    stateField,
    states,
    addedField: addField,
    workflow: workflowPath,
    committed: commit.committed,
  });
}

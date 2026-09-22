import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIELD_TYPES, fieldBase, isRelationLike, validateObject } from '../../core/index.js';
import type { FieldTypeRegistry } from '../../core/index.js';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { FieldAddOptions } from '../types/index.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** coerce a CLI string default into the field's typed default (base-driven) */
function parseDefault(registry: FieldTypeRegistry, type: string, raw: string): unknown {
  switch (fieldBase(registry, type)) {
    case FIELD_TYPES.INTEGER:
      return Number.parseInt(raw, 10);
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return Number(raw);
    case FIELD_TYPES.BOOLEAN:
      return raw === 'true';
    default:
      return raw;
  }
}

/**
 * `weave field:add <object> --name <field> --type <type> [--required] [--unique]
 * [--default <v>] [--options a,b,c] [--target <obj>]` — add a field to an
 * object's `schema.json`, validate the whole updated schema, and auto-commit.
 */
export async function fieldAdd(cwd: string, object: string, options: FieldAddOptions): Promise<void> {
  const p = options.printer;
  const { name, type } = options;

  if (!SNAKE_CASE.test(name)) {
    p.error(`field name must be snake_case: "${name}"`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(cwd);
  const fieldTypes = await resolveProjectFieldTypes(cwd, config);
  const typeValues: readonly string[] = Object.values(FIELD_TYPES);
  const isBuiltin = typeValues.includes(type);
  if (!isBuiltin && fieldTypes.get(type) === undefined) {
    p.error(`invalid field type "${type}" (expected a built-in or a registered field type)`);
    process.exitCode = 1;
    return;
  }
  const relationLike = isRelationLike(fieldTypes, type);
  if (type === FIELD_TYPES.ENUM && options.options === undefined) {
    p.error('enum fields require --options <a,b,c>');
    process.exitCode = 1;
    return;
  }
  if (relationLike && options.target === undefined) {
    p.error(`${type} fields require --target <object>`);
    process.exitCode = 1;
    return;
  }

  if (config.features?.fieldTypes !== undefined && !config.features.fieldTypes.includes(type)) {
    p.error(`field type "${type}" is disabled — add it to features.fieldTypes`);
    process.exitCode = 1;
    return;
  }
  const schemaDir = config.schemaDir ?? cwd;
  const schemaPath = join(schemaDir, 'objects', object, 'schema.json');

  let raw: string;
  try {
    raw = await readFile(schemaPath, 'utf8');
  } catch {
    p.error(`object "${object}" not found (${schemaPath})`);
    process.exitCode = 1;
    return;
  }
  let schema: { name?: string; fields?: Array<{ name?: string }> };
  try {
    schema = JSON.parse(raw) as typeof schema;
  } catch {
    p.error(`invalid JSON in ${schemaPath}`);
    process.exitCode = 1;
    return;
  }
  const fields = schema.fields;
  if (!Array.isArray(fields)) {
    p.error(`invalid schema for "${object}": missing fields array`);
    process.exitCode = 1;
    return;
  }
  if (fields.some((f) => f.name === name)) {
    p.error(`field "${name}" already exists on "${object}"`);
    process.exitCode = 1;
    return;
  }

  const field: Record<string, unknown> = { name, type };
  if (options.required === true) field.required = true;
  if (options.unique === true) field.unique = true;
  if (type === FIELD_TYPES.ENUM) {
    field.options = (options.options ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (relationLike) {
    field.target = options.target;
  }
  if (options.default !== undefined) field.default = parseDefault(fieldTypes, type, options.default);
  fields.push(field);

  try {
    validateObject(schema, { nameHint: object, allowedFieldTypes: config.features?.fieldTypes, fieldTypes });
  } catch (error) {
    p.error(`invalid schema after adding "${name}": ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  const commit = await autoCommit({ dir: schemaDir });
  p.log(
    `added field "${name}" (${type}) to "${object}"${commit.committed ? ` · committed ${commit.sha}` : ''}`,
  );
  p.data({ object, field: name, type, committed: commit.committed });
}

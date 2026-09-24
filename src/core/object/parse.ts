import { SchemaError } from '../types/errors.js';
import type { ObjectDefinition } from '../types/index.js';
import { migrateSchemaObject } from './migrations.js';
import { validateObject, type ValidateOptions } from './validate.js';

/**
 * Parse a `schema.json` file string into a validated object definition. Older
 * on-disk formats are migrated to the current one before validation, so
 * unversioned files keep loading. Throws a localized {@link SchemaError} on
 * invalid JSON, an unsupported format version, or an invalid schema.
 */
export function parseSchema(json: string, options?: ValidateOptions): ObjectDefinition {
  return parseObject(json, undefined, options);
}

/**
 * Parse a `schema.json` together with its sibling `objects/<name>/workflow.json`
 * (when present). The workflow is validated as part of the object so its
 * `stateField` can be checked against the object's fields. Either JSON being
 * invalid throws `parse.json.invalid`.
 */
export function parseObject(
  schemaJson: string,
  workflowJson: string | undefined,
  options?: ValidateOptions,
): ObjectDefinition {
  let data: unknown;
  try {
    data = JSON.parse(schemaJson);
  } catch {
    throw new SchemaError('parse.json.invalid');
  }
  const migrated =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? migrateSchemaObject(data as Record<string, unknown>, options?.locale).object
      : data;
  // only read/attach the sibling workflow when the schema opts in
  // (`workflowEnabled: true`); otherwise the file is kept but ignored, so a
  // parked/broken definition never blocks an object whose workflow is off
  if (
    workflowJson !== undefined &&
    typeof migrated === 'object' &&
    migrated !== null &&
    !Array.isArray(migrated) &&
    (migrated as Record<string, unknown>).workflowEnabled === true
  ) {
    let workflow: unknown;
    try {
      workflow = JSON.parse(workflowJson);
    } catch {
      throw new SchemaError('parse.json.invalid');
    }
    (migrated as Record<string, unknown>).workflow = workflow;
  }
  return validateObject(migrated, options);
}

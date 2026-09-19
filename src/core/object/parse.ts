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
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new SchemaError('parse.json.invalid');
  }
  const migrated =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? migrateSchemaObject(data as Record<string, unknown>, options?.locale).object
      : data;
  return validateObject(migrated, options);
}

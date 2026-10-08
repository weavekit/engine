import type { ToolJsonSchema } from './types.js';

/**
 * Pure validator for the `ToolJsonSchema` subset (no dependency). Used to reject
 * malformed tool-call arguments before a handler runs — the schema was
 * descriptive only until now.
 */
export interface ValidationResult {
  ok: boolean;
  /** human-readable failure path + reason (empty when ok) */
  detail: string;
}

function typeMatches(value: unknown, type: string | undefined): boolean {
  if (type === undefined) return true;
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // unknown declared type → don't constrain (forward-compatible)
      return true;
  }
}

/** validate `value` against `schema`; `path` is the JSON pointer used in the detail */
export function validateToolArgs(value: unknown, schema: ToolJsonSchema, path = 'args'): ValidationResult {
  if (!typeMatches(value, schema.type)) {
    return { ok: false, detail: `${path} must be of type "${schema.type}"` };
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
    return { ok: false, detail: `${path} must be one of: ${schema.enum.join(', ')}` };
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { ok: false, detail: `${path} must be >= ${schema.minimum}` };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { ok: false, detail: `${path} must be <= ${schema.maximum}` };
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const result = validateToolArgs(value[i], schema.items, `${path}[${i}]`);
      if (!result.ok) return result;
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) return { ok: false, detail: `${path}.${key} is required` };
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (properties[key] === undefined) return { ok: false, detail: `${path}.${key} is not allowed` };
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (record[key] === undefined) continue;
      const result = validateToolArgs(record[key], sub, `${path}.${key}`);
      if (!result.ok) return result;
    }
  }

  return { ok: true, detail: '' };
}

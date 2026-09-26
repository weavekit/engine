import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  FIELD_TYPES,
  fieldBase,
  fieldOpenApiFormat,
  type FieldDefinition,
  type FieldTypeRegistry,
  type ObjectDefinition,
} from '../../core/index.js';

type Json = Record<string, unknown>;

/** engine-managed (read-only) fields: system, computed, and sequence numbers. */
export function isReadonlyField(field: FieldDefinition): boolean {
  return (
    field.system === true ||
    (field as { formula?: string }).formula !== undefined ||
    field.type === FIELD_TYPES.SEQ_NO
  );
}

function asRecord(field: FieldDefinition): Record<string, unknown> {
  return field as unknown as Record<string, unknown>;
}

/** `required` is not present on every member of the field union. */
function fieldRequired(field: FieldDefinition): boolean {
  return asRecord(field).required === true;
}

/** JSON Schema primitive for a relation target's primary key. */
function pkType(
  target: string | undefined,
  objects: Map<string, ObjectDefinition>,
  registry: FieldTypeRegistry,
): string {
  const pk = target === undefined ? undefined : objects.get(target)?.fields.find((f) => f.primary === true);
  if (pk === undefined) return 'string';
  switch (fieldBase(registry, pk.type)) {
    case FIELD_TYPES.INTEGER:
      return 'integer';
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return 'number';
    case FIELD_TYPES.BOOLEAN:
      return 'boolean';
    default:
      return 'string';
  }
}

/**
 * JSON Schema for one field (OpenAPI 3.1). Carries type + format + validation
 * attributes, `readOnly` for engine-managed fields, and relation targets as
 * primary-key references. Dispatch is base-driven, so registered types inherit
 * their base's schema.
 */
export function fieldSchema(
  field: FieldDefinition,
  objects: Map<string, ObjectDefinition>,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): Json {
  const f = asRecord(field);
  const base = fieldBase(registry, field.type);
  const out: Json = {};

  const multipleImage = field.type === FIELD_TYPES.IMAGE && f.multiple === true;
  if (multipleImage) {
    out.type = 'array';
    out.items = { type: 'string', format: 'uri' };
  } else if (base === FIELD_TYPES.INTEGER) {
    out.type = 'integer';
  } else if (base === FIELD_TYPES.NUMBER || base === FIELD_TYPES.CURRENCY) {
    out.type = 'number';
  } else if (base === FIELD_TYPES.BOOLEAN) {
    out.type = 'boolean';
  } else if (base === FIELD_TYPES.TIMESTAMPTZ || base === FIELD_TYPES.TIMESTAMP) {
    out.type = 'string';
    out.format = 'date-time';
  } else if (base === FIELD_TYPES.DATE) {
    out.type = 'string';
    out.format = 'date';
  } else if (base === FIELD_TYPES.TIME || base === FIELD_TYPES.TIMETZ) {
    out.type = 'string';
    out.format = 'time';
  } else if (base === FIELD_TYPES.INTERVAL) {
    out.type = 'string';
    out.format = 'duration';
  } else if (base === FIELD_TYPES.JSON) {
    // free-form: leave unconstrained
  } else if (base === FIELD_TYPES.ENUM) {
    const opts = f.options as string[] | { from: { object: string; column?: string } };
    const dynamic = !Array.isArray(opts);
    if (f.multiple === true) {
      out.type = 'array';
      out.items = dynamic ? { type: 'string' } : { type: 'string', enum: opts as string[] };
    } else {
      out.type = 'string';
      if (!dynamic) out.enum = opts as string[];
    }
    if (dynamic) out['x-optionsFrom'] = { ...(opts as { from: { object: string; column?: string } }).from };
  } else if (base === FIELD_TYPES.MULTI_RELATION) {
    out.type = 'array';
    out.items = { type: pkType(f.target as string | undefined, objects, registry) };
  } else if (base === FIELD_TYPES.DETAILS) {
    out.type = 'array';
    out.items = { $ref: `#/components/schemas/${String(f.target)}` };
  } else if (base === FIELD_TYPES.RELATION) {
    out.type = pkType(f.target as string | undefined, objects, registry);
  } else {
    out.type = 'string';
    const format = fieldOpenApiFormat(registry, field.type);
    if (format !== undefined) out.format = format;
  }

  if (typeof f.minLength === 'number') out.minLength = f.minLength;
  if (typeof f.maxLength === 'number') out.maxLength = f.maxLength;
  if (typeof f.regex === 'string') out.pattern = f.regex;
  if (typeof f.min === 'number') out.minimum = f.min;
  if (typeof f.max === 'number') out.maximum = f.max;
  if (f.default !== undefined) out.default = f.default;
  if (field.description !== undefined) out.description = field.description;
  if (isReadonlyField(field)) out.readOnly = true;
  return out;
}

export interface ObjectSchemas {
  /** response record (sensitive fields omitted). */
  record: Json;
  /** create request body (writable fields; `required` preserved). */
  create: Json;
  /** update request body (writable, non-primary fields; all optional). */
  update: Json;
}

/** build the three reusable schemas for one object. */
export function objectSchemas(
  obj: ObjectDefinition,
  objects: Map<string, ObjectDefinition>,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): ObjectSchemas {
  const record: Json = { type: 'object', properties: {} as Json };
  const create: Json = { type: 'object', properties: {} as Json, additionalProperties: false };
  const update: Json = { type: 'object', properties: {} as Json, additionalProperties: false };
  const recordProps = record.properties as Json;
  const createProps = create.properties as Json;
  const updateProps = update.properties as Json;
  const recordRequired: string[] = [];
  const createRequired: string[] = [];

  for (const field of obj.fields) {
    const readonly = isReadonlyField(field);
    if (field.sensitive !== true) recordProps[field.name] = fieldSchema(field, objects, registry);
    if (field.primary === true || fieldRequired(field)) recordRequired.push(field.name);

    if (!readonly && field.type !== FIELD_TYPES.DETAILS) {
      createProps[field.name] = fieldSchema(field, objects, registry);
      if (fieldRequired(field)) createRequired.push(field.name);
    }
    if (!readonly && field.primary !== true && field.type !== FIELD_TYPES.DETAILS) {
      updateProps[field.name] = fieldSchema(field, objects, registry);
    }
  }

  if (recordRequired.length > 0) record.required = recordRequired;
  if (createRequired.length > 0) create.required = createRequired;
  return { record, create, update };
}

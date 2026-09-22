import type { ObjectDefinition, ObjectRegistry, RbacSubject, FieldDefinition, ToolDefinition } from '../../core/index.js';
import { FIELD_TYPES, primaryFieldOf, primaryKeyOf } from '../../core/index.js';
import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  fieldBase,
  type FieldTypeRegistry,
} from '../../core/index.js';
import { ACTION_PREFIXES } from '../../core/audit/index.js';
import { resolvePermission } from '../../core/rbac/index.js';
import type { ResolvedPermission } from '../../core/rbac/index.js';
import { READ_SCOPES } from '../../core/index.js';
import type { ToolExecutor } from '../../runtime/tools/index.js';
import { createHandler, deleteHandler, getHandler, searchHandler, updateHandler } from './tools.js';
import { describeObjectHandler, listObjectsHandler } from './introspection.js';
import type { JsonSchema, McpEngine, McpToolResult, McpToolSpec, ToolExecContext } from './types.js';
import { TOOL_PREFIXES } from './types.js';

/**
 * Compile the MCP tool surface for one subject: RBAC decides which objects and
 * which operations appear. `tools/list` returns exactly this list; `tools/call`
 * dispatches into the same handlers (whose data-access calls re-enforce RBAC —
 * the double layer).
 */

/** fields users can never write (system/formula/seq_no) — mirrors data-access validate */
function isReadonlyField(field: FieldDefinition): boolean {
  return field.system === true || field.type === FIELD_TYPES.SEQ_NO || (field as { formula?: string }).formula !== undefined;
}

/** target primary key JSON Schema type of a relation (fallback: string) */
function pkSchema(target: string, defs: Map<string, ObjectDefinition>, registry: FieldTypeRegistry): JsonSchema {
  const pk = primaryFieldOf(defs.get(target));
  if (pk === undefined) return { type: 'string' };
  return fieldValueSchema(pk, defs, registry);
}

/** JSON Schema for a single field *value* (enum → literal set, relation → pk) */
export function fieldValueSchema(
  field: FieldDefinition,
  defs: Map<string, ObjectDefinition>,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): JsonSchema {
  const base = fieldBase(registry, field.type);
  const f = field as unknown as Record<string, unknown>;
  switch (base) {
    case FIELD_TYPES.STRING:
    case FIELD_TYPES.TEXT:
    case FIELD_TYPES.DATETIME:
    case FIELD_TYPES.DATE:
    case FIELD_TYPES.SEQ_NO:
      return { type: 'string' };
    case FIELD_TYPES.INTEGER:
      return { type: 'integer' };
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return { type: 'number' };
    case FIELD_TYPES.BOOLEAN:
      return { type: 'boolean' };
    case FIELD_TYPES.JSON:
      return { type: 'object' };
    case FIELD_TYPES.ENUM: {
      const options = (f.options as string[] | undefined) ?? [];
      if (f.multiple === true) {
        return { type: 'array', items: { type: 'string', enum: options } };
      }
      return { type: 'string', enum: options };
    }
    case FIELD_TYPES.RELATION:
      return pkSchema(String(f.target), defs, registry);
    case FIELD_TYPES.MULTI_RELATION:
      return { type: 'array', items: pkSchema(String(f.target), defs, registry) };
    case FIELD_TYPES.DETAILS:
      return { type: 'array', items: { type: 'object' } };
    default:
      return { type: 'string' };
  }
}

/** read output fields for a subject: every field minus the RBAC `exclude` list */
function readableFields(def: ObjectDefinition, perm: ResolvedPermission): FieldDefinition[] {
  const excluded = new Set(perm.exclude);
  return def.fields.filter((f) => !excluded.has(f.name));
}

/** fields a subject can write on create: non-readonly, non-excluded, minus details (managed via child CRUD) */
function writableCreateFields(def: ObjectDefinition, perm: ResolvedPermission): FieldDefinition[] {
  const excluded = new Set(perm.exclude);
  const base = def.fields.filter((f) => !isReadonlyField(f) && !excluded.has(f.name) && f.type !== FIELD_TYPES.DETAILS);
  // `perm.createFields === null` = unrestricted (no fields.create declared)
  if (perm.createFields === null) return base;
  const whitelist = new Set(perm.createFields);
  return base.filter((f) => whitelist.has(f.name));
}

/** fields a subject can write on update: RBAC `update` whitelist (null = all writable) */
function updatableFields(def: ObjectDefinition, perm: ResolvedPermission): FieldDefinition[] {
  const excluded = new Set(perm.exclude);
  if (perm.update === null) {
    return def.fields.filter((f) => !isReadonlyField(f) && !excluded.has(f.name) && f.type !== FIELD_TYPES.DETAILS);
  }
  const whitelist = new Set(perm.update);
  return def.fields.filter((f) => whitelist.has(f.name) && !isReadonlyField(f) && f.type !== FIELD_TYPES.DETAILS);
}

function objectSchema(
  fields: FieldDefinition[],
  defs: Map<string, ObjectDefinition>,
  registry: FieldTypeRegistry,
  requiredOnly = false,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = { ...fieldValueSchema(field, defs, registry), description: field.description };
    if (('required' in field && field.required === true) || field.primary === true) required.push(field.name);
  }
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (requiredOnly) {
    if (required.length > 0) schema.required = required;
  } else if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

export interface CompiledTool {
  spec: McpToolSpec;
  objectName: string | undefined;
}

/** custom-tool surface merged into the session tool surface (roles filtered by the executor, D8-cached) */
function customToolTools(
  engine: McpEngine,
  subject: RbacSubject,
  custom: { defs: ToolDefinition[]; executor: ToolExecutor },
): CompiledTool[] {
  return custom.executor.surface(subject, custom.defs).map((entry) => {
    const def = custom.defs.find((d) => d.name === entry.name) as ToolDefinition;
    return {
      objectName: undefined,
      spec: {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        handler: async (args: Record<string, unknown>, ctx: ToolExecContext): Promise<McpToolResult> => {
          // rate limit at the adapter layer (agentKey, widened by roles:tool — M10 D6)
          const scope = `${[...ctx.session.user.roles].sort().join(',')}:${def.name}`;
          if (!ctx.guardrails.checkRateLimit(ctx.session.agentKey, scope)) {
            const { SchemaError } = await import('../../core/index.js');
            throw new SchemaError('mcp.rateLimited', {}, ctx.engine.locale);
          }
          const result = await custom.executor.execute(def, args, {
            subject: ctx.session.user,
            actor: {
              key: ctx.session.agentKey,
              label: ctx.session.agentSubject.id,
              onBehalfOf: ctx.session.onBehalfOf,
            },
            action: `${ACTION_PREFIXES.MCP_TOOL}.${def.name}`,
            args,
            locale: ctx.engine.locale,
          });
          return result as McpToolResult;
        },
      },
    };
  });
}

/** build the per-object CRUD tools (search/get/create/update/delete) */
function objectTools(
  def: ObjectDefinition,
  defs: Map<string, ObjectDefinition>,
  perm: ResolvedPermission,
  registry: FieldTypeRegistry,
): CompiledTool[] {
  const tools: CompiledTool[] = [];
  const pkField = primaryFieldOf(def);
  const pkName = primaryKeyOf(def);
  const idSchema: JsonSchema = pkField !== undefined ? fieldValueSchema(pkField, defs, registry) : { type: 'string' };
  const readable = readableFields(def, perm);

  if (perm.read !== undefined) {
    const readFields = readable.map((f) => f.name);
    tools.push({
      objectName: def.name,
      spec: {
        name: `${TOOL_PREFIXES.SEARCH}${def.name}`,
        description: `Search ${def.name} records (rows are filtered to your read scope)`,
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'object',
              description: `filter by exact values or operators on readable fields: ${readFields.join(', ') || '(none)'}`,
              additionalProperties: true,
            },
            sort: {
              type: 'array',
              description: `sort by readable fields: ${readFields.join(', ') || '(none)'}`,
              items: {
                type: 'object',
                properties: { field: { type: 'string', enum: readFields }, direction: { type: 'string', enum: ['asc', 'desc'] } },
                required: ['field'],
              },
            },
            limit: { type: 'integer', minimum: 1, maximum: 1000 },
            offset: { type: 'integer', minimum: 0 },
            fields: { type: 'array', items: { type: 'string', enum: readFields } },
          },
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => searchHandler(def, args, ctx),
      },
    });
    tools.push({
      objectName: def.name,
      spec: {
        name: `${TOOL_PREFIXES.GET}${def.name}`,
        description: `Fetch one ${def.name} record by ${pkName ?? 'primary key'} (404 → not found error)`,
        inputSchema: {
          type: 'object',
          properties: { [pkName ?? 'id']: { ...idSchema, description: 'primary key' } },
          required: [pkName ?? 'id'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => getHandler(def, args, ctx),
      },
    });
  }

  if (perm.create === true) {
    tools.push({
      objectName: def.name,
      spec: {
        name: `${TOOL_PREFIXES.CREATE}${def.name}`,
        description: `Create a ${def.name} record`,
        inputSchema: {
          type: 'object',
          properties: {
            data: { ...objectSchema(writableCreateFields(def, perm), defs, registry, true), description: 'fields to set' },
          },
          required: ['data'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => createHandler(def, args, ctx),
      },
    });
  }

  if (perm.update === null || perm.update.length > 0) {
    tools.push({
      objectName: def.name,
      spec: {
        name: `${TOOL_PREFIXES.UPDATE}${def.name}`,
        description: `Update a ${def.name} record (only whitelisted fields are accepted)`,
        inputSchema: {
          type: 'object',
          properties: {
            [pkName ?? 'id']: { ...idSchema, description: 'primary key' },
            changes: { ...objectSchema(updatableFields(def, perm), defs, registry), description: 'fields to change' },
          },
          required: [pkName ?? 'id', 'changes'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => updateHandler(def, args, ctx),
      },
    });
  }

  if (perm.delete === true) {
    tools.push({
      objectName: def.name,
      spec: {
        name: `${TOOL_PREFIXES.DELETE}${def.name}`,
        description: `Delete a ${def.name} record`,
        inputSchema: {
          type: 'object',
          properties: { [pkName ?? 'id']: { ...idSchema, description: 'primary key' } },
          required: [pkName ?? 'id'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => deleteHandler(def, args, ctx),
      },
    });
  }

  return tools;
}

/**
 * Compile the full tool surface for a subject: CRUD tools for every object the
 * subject can touch (per RBAC) plus the always-on introspection tools plus the
 * subject-visible custom tools (M10b, roles-filtered by the executor).
 */
export function compileToolsFor(
  engine: McpEngine,
  subject: RbacSubject,
  custom?: { defs: ToolDefinition[]; executor: ToolExecutor },
): CompiledTool[] {
  const registry: ObjectRegistry = engine.registry;
  const fieldTypes = registry.fieldTypes;
  const defs = new Map(registry.list().map((def) => [def.name, def]));
  const tools: CompiledTool[] = [];

  for (const def of registry.list()) {
    const perm = resolvePermission(def, subject.roles);
    if (perm === undefined) continue; // role not listed → object invisible
    tools.push(...objectTools(def, defs, perm, fieldTypes));
  }

  tools.push(
    {
      objectName: undefined,
      spec: {
        name: 'list_objects',
        description: 'List objects the current identity can read',
        inputSchema: { type: 'object' },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => listObjectsHandler(args, ctx),
      },
    },
    {
      objectName: undefined,
      spec: {
        name: 'describe_object',
        description: 'Describe an object schema (fields, relations, permissions) for the current identity',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'object name' } },
          required: ['name'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => describeObjectHandler(args, ctx),
      },
    },
  );

  if (custom !== undefined) {
    tools.push(...customToolTools(engine, subject, custom));
  }

  return tools;
}

export { READ_SCOPES };

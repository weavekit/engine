import type { ObjectRegistry, RbacSubject, ToolDefinition } from '../../core/index.js';
import { INTROSPECTION_TOOLS, REGISTRY_TOOLS, resolvePermission } from '../../core/index.js';
import type { ResolvedPermission } from '../../core/index.js';
import { ACTION_PREFIXES } from '../../core/audit/index.js';
import type { ToolExecutor } from '../../runtime/tools/index.js';
import {
  createRecordHandler,
  deleteRecordHandler,
  getRecordHandler,
  searchRecordsHandler,
  updateRecordHandler,
} from './tools.js';
import { describeObjectHandler, listObjectsHandler } from './introspection.js';
import type { JsonSchema, McpEngine, McpToolResult, McpToolSpec, ToolExecContext } from './types.js';

/**
 * Compile the MCP tool surface for one subject.
 *
 * The surface is a **fixed registry**: introspection (`list_objects` /
 * `describe_object`) plus one generic CRUD tool per capability, each taking the
 * target object name as an argument — so the surface does **not** grow with the
 * number of objects. RBAC decides which capabilities appear (an op is exposed
 * only when the subject may perform it on at least one object); `tools/call`
 * dispatches into the same handlers, whose data-access calls re-enforce RBAC per
 * object (the double layer).
 */

/** a compiled MCP tool (per-session; the surface is filtered by RBAC) */
export interface CompiledTool {
  spec: McpToolSpec;
  objectName: string | undefined;
}

/** capabilities the subject holds on at least one object (drives which generic ops appear) */
function capabilities(
  registry: ObjectRegistry,
  subject: RbacSubject,
): { read: boolean; create: boolean; update: boolean; delete: boolean } {
  const caps = { read: false, create: false, update: false, delete: false };
  for (const def of registry.list()) {
    const p: ResolvedPermission | undefined = resolvePermission(def, subject.roles);
    if (p === undefined) continue;
    if (p.read !== undefined) caps.read = true;
    if (p.create === true) caps.create = true;
    // `update === null` = all fields updatable; `[]` = none; `undefined` = no update permission
    if (p.update === null || (Array.isArray(p.update) && p.update.length > 0)) caps.update = true;
    if (p.delete === true) caps.delete = true;
  }
  return caps;
}

const OBJECT_ARG: JsonSchema = {
  type: 'string',
  description: 'the object name (see list_objects); call describe_object for its fields and permissions',
};

/** the generic CRUD tools for the capabilities the subject holds on any object */
function registryTools(engine: McpEngine, subject: RbacSubject): CompiledTool[] {
  const caps = capabilities(engine.registry, subject);
  const tools: CompiledTool[] = [];

  if (caps.read) {
    tools.push(
      {
        objectName: undefined,
        spec: {
          name: REGISTRY_TOOLS.SEARCH,
          description: 'Search records of an object (rows are filtered to your read scope)',
          inputSchema: {
            type: 'object',
            properties: {
              object: OBJECT_ARG,
              filter: {
                type: 'object',
                description: 'filter by exact values or operators on readable fields',
                additionalProperties: true,
              },
              sort: {
                type: 'array',
                description: 'sort by readable fields',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
                  required: ['field'],
                },
              },
              limit: { type: 'integer', minimum: 1, maximum: 1000 },
              offset: { type: 'integer', minimum: 0 },
              fields: { type: 'array', items: { type: 'string' } },
            },
            required: ['object'],
          },
          handler: (args: Record<string, unknown>, ctx: ToolExecContext) => searchRecordsHandler(args, ctx),
        },
      },
      {
        objectName: undefined,
        spec: {
          name: REGISTRY_TOOLS.GET,
          description: 'Fetch one record of an object by its primary key (not found → error)',
          inputSchema: {
            type: 'object',
            properties: { object: OBJECT_ARG, id: { type: 'string', description: 'primary key' } },
            required: ['object', 'id'],
          },
          handler: (args: Record<string, unknown>, ctx: ToolExecContext) => getRecordHandler(args, ctx),
        },
      },
    );
  }

  if (caps.create) {
    tools.push({
      objectName: undefined,
      spec: {
        name: REGISTRY_TOOLS.CREATE,
        description: 'Create a record of an object (only fields you may write are accepted)',
        inputSchema: {
          type: 'object',
          properties: {
            object: OBJECT_ARG,
            data: { type: 'object', description: 'fields to set', additionalProperties: true },
          },
          required: ['object', 'data'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => createRecordHandler(args, ctx),
      },
    });
  }

  if (caps.update) {
    tools.push({
      objectName: undefined,
      spec: {
        name: REGISTRY_TOOLS.UPDATE,
        description: 'Update a record of an object (only fields you may update are accepted)',
        inputSchema: {
          type: 'object',
          properties: {
            object: OBJECT_ARG,
            id: { type: 'string', description: 'primary key' },
            changes: { type: 'object', description: 'fields to change', additionalProperties: true },
          },
          required: ['object', 'id', 'changes'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => updateRecordHandler(args, ctx),
      },
    });
  }

  if (caps.delete) {
    tools.push({
      objectName: undefined,
      spec: {
        name: REGISTRY_TOOLS.DELETE,
        description: 'Delete a record of an object by its primary key',
        inputSchema: {
          type: 'object',
          properties: { object: OBJECT_ARG, id: { type: 'string', description: 'primary key' } },
          required: ['object', 'id'],
        },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => deleteRecordHandler(args, ctx),
      },
    });
  }

  return tools;
}

/** custom-tool surface merged into the session tool surface (roles filtered by the executor, cached per subject) */
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
          // rate limit at the adapter layer (agentKey, widened by `roles:tool` scope)
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

/**
 * Compile the full tool surface for a subject: the generic CRUD tools the
 * subject's RBAC permits, the always-on introspection tools, and the
 * subject-visible custom tools (roles-filtered by the executor).
 */
export function compileToolsFor(
  engine: McpEngine,
  subject: RbacSubject,
  custom?: { defs: ToolDefinition[]; executor: ToolExecutor },
): CompiledTool[] {
  const tools: CompiledTool[] = [...registryTools(engine, subject)];

  tools.push(
    {
      objectName: undefined,
      spec: {
        name: INTROSPECTION_TOOLS.LIST_OBJECTS,
        description: 'List objects the current identity can read',
        inputSchema: { type: 'object' },
        handler: (args: Record<string, unknown>, ctx: ToolExecContext) => listObjectsHandler(args, ctx),
      },
    },
    {
      objectName: undefined,
      spec: {
        name: INTROSPECTION_TOOLS.DESCRIBE_OBJECT,
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

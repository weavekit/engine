import type { Locale } from '../i18n/index.js';
import { describeObject } from '../object/describe.js';
import type { ObjectRegistry } from '../object/registry.js';
import { resolvePermissionFor } from '../rbac/index.js';
import type { PromptDescriptor, PromptMessage, PromptResult } from '../provider/prompts/index.js';
import { SchemaError } from '../types/errors.js';
import { BUILTIN_PROMPTS } from './values.js';

/**
 * Built-in MCP prompts, derived from the schema (not authored business content),
 * so a headless engine can still guide an agent to use its own tool surface:
 *
 *   explore_data           → the list_objects → describe_object → search_records flow
 *   object_guide(object)   → one object's descriptor + which tools to use
 *   build_filter(object)   → how to shape a search_records filter
 *   run_workflow(object)   → the object's workflow transitions
 *
 * The surface is RBAC-filtered per identity (only readable objects appear), and
 * every render re-checks the identity's permissions (list + get, like the tool
 * surface). Instruction text is English (matching the tool descriptions); the
 * schema payload is language-neutral JSON.
 */

const OBJECT_ARG_DESC = 'object name (see list_objects)';

function text(message: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text: message } };
}

/** objects the identity may read (mirrors `list_objects`) */
function readableObjects(registry: ObjectRegistry, roles: readonly string[]) {
  return registry.list().filter((def) => resolvePermissionFor(registry, def, roles)?.read !== undefined);
}

/** the built-in prompts visible to the identity (empty when it can read nothing) */
export function builtinPromptDescriptors(registry: ObjectRegistry, roles: readonly string[]): PromptDescriptor[] {
  const readable = readableObjects(registry, roles);
  if (readable.length === 0) return [];

  const prompts: PromptDescriptor[] = [
    {
      name: BUILTIN_PROMPTS.EXPLORE,
      description: 'Step-by-step guide to explore data with the built-in tools',
    },
    {
      name: BUILTIN_PROMPTS.OBJECT_GUIDE,
      description: 'Guidance for working with one object (fields, relations and your permissions)',
      arguments: [{ name: 'object', description: OBJECT_ARG_DESC, required: true }],
    },
    {
      name: BUILTIN_PROMPTS.BUILD_FILTER,
      description: 'How to build a search_records filter for one object',
      arguments: [{ name: 'object', description: OBJECT_ARG_DESC, required: true }],
    },
  ];

  if (readable.some((def) => def.workflow !== undefined)) {
    prompts.push({
      name: BUILTIN_PROMPTS.RUN_WORKFLOW,
      description: 'How to fire a workflow transition on one object',
      arguments: [{ name: 'object', description: OBJECT_ARG_DESC, required: true }],
    });
  }
  return prompts;
}

function requireArg(args: Record<string, string>, key: string, name: string, locale: Locale): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError('prompt.args.invalid', { name, detail: `missing required argument "${key}"` }, locale);
  }
  return value;
}

function exploreText(): string {
  return [
    'Explore the data available to you through the WeaveKit tools.',
    '',
    '1. Call list_objects to see the objects your identity can read.',
    '2. Call describe_object for one to get its fields, relations and your permissions.',
    '3. Call search_records (with a filter/sort/limit) to read rows — rows are already scoped to what you may see.',
    '4. Use get_record for one row, and create_record / update_record / delete_record to write (only permitted fields).',
    '',
    'Start with list_objects and tell me what you find.',
  ].join('\n');
}

function objectGuideText(descriptor: object, name: string): string {
  return [
    `Work with the "${name}" object.`,
    '',
    'Metadata (schema + your permissions):',
    JSON.stringify(descriptor, null, 2),
    '',
    'Guidance:',
    `- Read rows with search_records (object="${name}"); fetch one with get_record (id = the record id).`,
    '- Write with create_record / update_record / delete_record; only fields your role permits are accepted.',
    '- Row scope is applied automatically; use describe_object to refresh this metadata at any time.',
  ].join('\n');
}

function buildFilterText(name: string, fields: Array<{ name: string; type: string }>): string {
  const lines = fields.map((f) => `- ${f.name} (${f.type})`);
  return [
    `Build a search_records filter for "${name}".`,
    '',
    'Readable fields:',
    ...lines,
    '',
    'Filter shape: { "<field>": <value> } for equality, or { "<field>": { "<op>": <value> } } for an operator',
    '(eq, ne, gt, gte, lt, lte, in, contains, like). Multiple fields are AND\u2019d; use { "$or": [ ... ] } for OR.',
    'sort is an array of { field, direction } (asc | desc).',
    `Call search_records with object="${name}" and your filter.`,
  ].join('\n');
}

function runWorkflowText(name: string, workflow: object): string {
  return [
    `Fire a workflow transition on "${name}".`,
    '',
    'Workflow (states + transitions):',
    JSON.stringify(workflow, null, 2),
    '',
    `Call workflow_transition with object="${name}", id=<record id>, and action=<a transition allowed from the`,
    'record\u2019s current state and by your role \u2014 see describe_object \u2192 workflow).',
  ].join('\n');
}

/**
 * Render a built-in prompt. Throws `prompt.args.invalid` (missing/empty arg or a
 * non-workflow object for `run_workflow`), `data.objectUnknown` (unknown object)
 * or `rbac.denied.read` (identity may not read the object) — mapping to a
 * protocol error at the MCP layer.
 */
export function renderBuiltinPrompt(
  registry: ObjectRegistry,
  name: string,
  args: Record<string, string>,
  roles: readonly string[],
  locale: Locale,
): PromptResult {
  switch (name) {
    case BUILTIN_PROMPTS.EXPLORE:
      return { description: 'Explore the available data', messages: [text(exploreText())] };
    case BUILTIN_PROMPTS.OBJECT_GUIDE: {
      const object = requireArg(args, 'object', name, locale);
      const descriptor = describeObject(registry, object, roles, locale);
      return {
        description: `Work with the "${object}" object`,
        messages: [text(objectGuideText(descriptor, object))],
      };
    }
    case BUILTIN_PROMPTS.BUILD_FILTER: {
      const object = requireArg(args, 'object', name, locale);
      const descriptor = describeObject(registry, object, roles, locale);
      const fields = descriptor.fields.filter((f) => f.virtual !== true).map((f) => ({ name: f.name, type: f.type }));
      return {
        description: `Build a search_records filter for "${object}"`,
        messages: [text(buildFilterText(object, fields))],
      };
    }
    case BUILTIN_PROMPTS.RUN_WORKFLOW: {
      const object = requireArg(args, 'object', name, locale);
      const descriptor = describeObject(registry, object, roles, locale);
      if (descriptor.workflow === undefined) {
        throw new SchemaError('prompt.args.invalid', { name, detail: `object "${object}" has no workflow` }, locale);
      }
      return {
        description: `Fire a workflow transition on "${object}"`,
        messages: [text(runWorkflowText(object, descriptor.workflow))],
      };
    }
    default:
      throw new SchemaError('prompt.notFound', { name }, locale);
  }
}

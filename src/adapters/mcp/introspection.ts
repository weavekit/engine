import { describeObject, listObjectDescriptors } from '../../core/object/describe.js';
import type { McpToolResult, ToolExecContext } from './types.js';

/**
 * Introspection tools: `list_objects` (objects the identity can read) and
 * `describe_object` (schema + the identity's effective permissions). Both are
 * filtered by RBAC — excluded fields are stripped from the description. The
 * logic is protocol-agnostic and shared with the REST metadata endpoints
 * (`core/object/describe.js`); this file only binds it to the MCP text result.
 */

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export async function listObjectsHandler(_args: Record<string, unknown>, ctx: ToolExecContext): Promise<McpToolResult> {
  const visible = listObjectDescriptors(ctx.engine.registry, ctx.session.user.roles);
  return textResult(JSON.stringify({ objects: visible }));
}

export async function describeObjectHandler(args: Record<string, unknown>, ctx: ToolExecContext): Promise<McpToolResult> {
  const descriptor = describeObject(ctx.engine.registry, String(args.name ?? ''), ctx.session.user.roles, ctx.engine.locale);
  return textResult(JSON.stringify(descriptor));
}

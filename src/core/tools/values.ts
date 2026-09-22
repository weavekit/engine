/**
 * Tool-surface constants — single source of truth (as const, see AGENTS.md).
 * Moved from `adapters/mcp/types.ts` so `core/tools` (contract) and the
 * loader/executor (runtime) share one reserved-name source. No second
 * hardcoded union anywhere.
 */

/**
 * the fixed registry-mode tools: one generic CRUD op per capability, taking the
 * target object name as an argument (the surface does not grow with the number
 * of objects). `list_objects`/`describe_object` reveal the available objects.
 */
export const REGISTRY_TOOLS = {
  SEARCH: 'search_records',
  GET: 'get_record',
  CREATE: 'create_record',
  UPDATE: 'update_record',
  DELETE: 'delete_record',
} as const;
export type RegistryTool = typeof REGISTRY_TOOLS[keyof typeof REGISTRY_TOOLS];

/** always-on introspection tool names */
export const INTROSPECTION_TOOLS = {
  LIST_OBJECTS: 'list_objects',
  DESCRIBE_OBJECT: 'describe_object',
} as const;

/** custom tool `name` format (snake_case, lowercase start) */
export const TOOL_NAME_PATTERN = '^[a-z][a-z0-9_]*$';

/** audit namespace prefix custom tools must not use (action = `<prefix>.<detail>`) */
export const RESERVED_TOOL_NAMESPACE = 'mcp.';

/** approval queue statuses — single source of truth (as const, AGENTS hard rule) */
export const APPROVAL_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[keyof typeof APPROVAL_STATUSES];

const reservedNames: readonly string[] = [...Object.values(REGISTRY_TOOLS), ...Object.values(INTROSPECTION_TOOLS)];

/** true when a custom tool name collides with a built-in tool or the audit namespace */
export function isReservedToolName(name: string): boolean {
  return reservedNames.includes(name) || name.startsWith(RESERVED_TOOL_NAMESPACE);
}

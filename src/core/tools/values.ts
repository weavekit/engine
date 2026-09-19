/**
 * Tool-surface constants — single source of truth (as const, see AGENTS.md).
 * Moved from `adapters/mcp/types.ts` so `core/tools` (contract) and the
 * loader/executor (runtime) share one reserved-name source. No second
 * hardcoded union anywhere.
 */

/** prefixes of the generated per-object CRUD tools */
export const TOOL_PREFIXES = {
  SEARCH: 'search_',
  GET: 'get_',
  CREATE: 'create_',
  UPDATE: 'update_',
  DELETE: 'delete_',
} as const;
export type ToolPrefix = typeof TOOL_PREFIXES[keyof typeof TOOL_PREFIXES];

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

const reservedPrefixes: readonly string[] = Object.values(TOOL_PREFIXES);
const reservedNames: readonly string[] = Object.values(INTROSPECTION_TOOLS);

/** true when a custom tool name collides with a generated tool or the audit namespace */
export function isReservedToolName(name: string): boolean {
  return reservedNames.includes(name) || reservedPrefixes.some((p) => name.startsWith(p)) || name.startsWith(RESERVED_TOOL_NAMESPACE);
}

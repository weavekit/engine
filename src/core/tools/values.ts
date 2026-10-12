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

/** fixed workflow tool names (exposed to subjects that can update a workflow object) */
export const WORKFLOW_TOOLS = {
  TRANSITION: 'workflow_transition',
} as const;
export type WorkflowTool = typeof WORKFLOW_TOOLS[keyof typeof WORKFLOW_TOOLS];

/**
 * fixed approval-queue tool names. Exposed only to admin subjects when an
 * approval queue is wired (the queue carries request arguments — a write
 * authority boundary, mirrors the REST `/approvals` admin gate).
 */
export const APPROVAL_TOOLS = {
  LIST: 'list_approvals',
  APPROVE: 'approve_approval',
  REJECT: 'reject_approval',
} as const;
export type ApprovalTool = typeof APPROVAL_TOOLS[keyof typeof APPROVAL_TOOLS];

/** custom tool `name` format (snake_case, lowercase start) */
export const TOOL_NAME_PATTERN = '^[a-z][a-z0-9_]*$';

/** audit namespace prefix custom tools must not use (action = `<prefix>.<detail>`) */
export const RESERVED_TOOL_NAMESPACE = 'mcp.';

/** approval queue statuses — single source of truth (as const, AGENTS hard rule) */
// approval queue statuses live in @weave-kit/contract (single source of truth)
export { APPROVAL_STATUSES } from '@weave-kit/contract/values';
export type { ApprovalStatus } from '@weave-kit/contract/values';

const reservedNames: readonly string[] = [
  ...Object.values(REGISTRY_TOOLS),
  ...Object.values(INTROSPECTION_TOOLS),
  ...Object.values(WORKFLOW_TOOLS),
  ...Object.values(APPROVAL_TOOLS),
];

/** true when a custom tool name collides with a built-in tool or the audit namespace */
export function isReservedToolName(name: string): boolean {
  return reservedNames.includes(name) || name.startsWith(RESERVED_TOOL_NAMESPACE);
}

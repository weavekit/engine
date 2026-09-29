import { WORKFLOW_ASSIGN_MODES, WORKFLOW_FORMAT_VERSION } from '../../core/index.js';
import type { WorkflowDefinition, WorkflowNode } from '../../core/index.js';

/** starter node roles when the caller does not pass `--roles` */
export const DEFAULT_WORKFLOW_ROLES = ['approver'] as const;

/** parse `--roles a,b,c`; returns `undefined` when the argument is absent */
export function parseRoles(input: string | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** a valid starter single-line node-chain workflow for a fresh object */
export function buildStarterWorkflow(roles: string[]): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    {
      id: 'review',
      kind: 'approve',
      name: { en: 'Review' },
      assign: { roles, mode: WORKFLOW_ASSIGN_MODES.ANY },
    },
  ];
  return { schemaVersion: WORKFLOW_FORMAT_VERSION, nodes };
}

/** stable `workflow.json` rendering (readable key order) */
export function renderWorkflow(workflow: WorkflowDefinition): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

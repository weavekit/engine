import { WORKFLOW_FORMAT_VERSION } from '../../core/index.js';
import type { WorkflowDefinition, WorkflowState, WorkflowTransition } from '../../core/index.js';

/** starter state names when the caller does not pass `--states` (order = lifecycle) */
export const DEFAULT_WORKFLOW_STATES = ['draft', 'pending', 'approved', 'archived'] as const;

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/** parse `--states a,b,c`; returns `undefined` when the argument is absent */
export function parseStates(input: string | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** validate a candidate state list; returns an error message or `undefined` when valid */
export function stateListError(states: string[]): string | undefined {
  if (states.length < 2) return 'at least two states are required';
  for (const state of states) {
    if (!SNAKE_CASE.test(state)) return `state "${state}" must be snake_case`;
  }
  if (new Set(states).size !== states.length) return 'states must be unique';
  return undefined;
}

/** Title Case a snake_case state name for a default display label */
function titleCase(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const NAMED_LIFECYCLE = new Set(['draft', 'pending', 'approved', 'archived']);

/**
 * Starter edges: the named review lifecycle for the default state set, otherwise
 * a generic linear `advance` chain plus a `reopen` back to the initial state.
 * Generic keeps any `--states` list valid without inventing per-state semantics.
 */
export function starterTransitions(states: string[]): WorkflowTransition[] {
  const isDefault =
    states.length === NAMED_LIFECYCLE.size && states.every((s) => NAMED_LIFECYCLE.has(s));
  if (isDefault) {
    return [
      { action: 'submit', from: 'draft', to: 'pending', labels: { en: 'Submit' } },
      { action: 'approve', from: 'pending', to: 'approved', labels: { en: 'Approve' } },
      { action: 'reject', from: 'pending', to: 'draft', labels: { en: 'Reject' } },
      { action: 'archive', from: 'approved', to: 'archived', labels: { en: 'Archive' } },
      { action: 'reopen', from: 'archived', to: 'draft', labels: { en: 'Reopen' } },
    ];
  }
  const out: WorkflowTransition[] = [];
  for (let i = 0; i + 1 < states.length; i += 1) {
    const from = states[i];
    const to = states[i + 1];
    if (from === undefined || to === undefined) continue;
    out.push({ action: 'advance', from, to });
  }
  const first = states[0];
  const last = states[states.length - 1];
  if (first !== undefined && last !== undefined) {
    out.push({ action: 'reopen', from: last, to: first });
  }
  return out;
}

/** a valid starter definition for a fresh object workflow */
export function buildStarterWorkflow(stateField: string, states: string[]): WorkflowDefinition {
  const initial = states[0];
  if (initial === undefined) throw new Error('workflow requires at least one state');
  const declared: WorkflowState[] = states.map((name) => ({ name, labels: { en: titleCase(name) } }));
  return {
    schemaVersion: WORKFLOW_FORMAT_VERSION,
    stateField,
    initial,
    states: declared,
    transitions: starterTransitions(states),
  };
}

/** stable `workflow.json` rendering (readable key order) */
export function renderWorkflow(workflow: WorkflowDefinition): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

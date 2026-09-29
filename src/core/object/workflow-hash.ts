import { createHash } from 'node:crypto';
import type { WorkflowDefinition } from '../types/index.js';

/** deterministic JSON: recursively sorted object keys, `undefined` entries dropped */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Content-addressed identity of a workflow's runtime semantics (the author's
 * `version` and the ordered `nodes` chain). The on-disk `schemaVersion` (format)
 * is excluded, so the hash changes only when a node/assign/rollback/timeout
 * could behave differently. Written into the descriptor, transition events,
 * audit and timers as a traceability anchor; instances pin it at submit.
 */
export function hashWorkflow(workflow: WorkflowDefinition): string {
  const semantic = {
    ...(workflow.version === undefined ? {} : { version: workflow.version }),
    nodes: workflow.nodes,
  };
  return createHash('sha256').update(canonical(semantic), 'utf8').digest('hex');
}

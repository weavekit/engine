/**
 * Declarative per-object state machine (`objects/<name>/workflow.json`).
 * Pure types — zero runtime dependencies (core contract layer).
 */

/** on-disk `workflow.json` format version (single source of truth) */
export const WORKFLOW_FORMAT_VERSION = 1 as const;

/** one named state a record can be in (must be one of the state field's enum options) */
export interface WorkflowState {
  /** snake_case state name; must exist in the state field's inline options */
  name: string;
  /** display names keyed by locale, e.g. { en: 'Draft', zh: '草稿' } */
  labels?: Record<string, string>;
  description?: string;
}

/** one guarded edge between two states */
export interface WorkflowTransition {
  /** snake_case action name, unique within a `from` state */
  action: string;
  /** source state name */
  from: string;
  /** target state name */
  to: string;
  labels?: Record<string, string>;
  /** roles allowed to fire this transition; absent = any identity allowed to update */
  roles?: string[];
}

/** validated workflow definition attached to an object */
export interface WorkflowDefinition {
  /** on-disk `workflow.json` format version */
  schemaVersion?: number;
  /** enum field on the object that carries the current state */
  stateField: string;
  /** state assigned to new records */
  initial: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

/** `weavekit.config.ts -> subsystems.workflow` */
export interface EngineWorkflowConfig {
  enabled?: boolean;
}

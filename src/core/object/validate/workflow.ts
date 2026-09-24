import { FIELD_TYPES } from '../../types/values.js';
import type { FieldDefinition } from '../../types/fields.js';
import { WORKFLOW_FORMAT_VERSION, parseDuration } from '../../types/workflow.js';
import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowTimeout,
  WorkflowTransition,
} from '../../types/workflow.js';
import { validateLabels } from './labels.js';
import { fail, isRecord, SNAKE_CASE, type Vc } from './primitives.js';

/**
 * Validate a declared state machine (`objects/<name>/workflow.json`). Self-contained:
 * the state field must be an enum field on the same object with inline options, every
 * state must be one of those options, and transitions must reference declared states.
 * Returns `undefined` when no workflow is declared.
 */
export function validateWorkflow(
  raw: unknown,
  fields: FieldDefinition[],
  vc: Vc,
): WorkflowDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'workflow.notObject');

  // on-disk format version (fail-closed on unknown/future versions)
  let schemaVersion: number | undefined;
  const rawVersion = raw.schemaVersion;
  if (rawVersion !== undefined) {
    if (
      typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1 ||
      rawVersion > WORKFLOW_FORMAT_VERSION
    ) {
      fail(vc, 'schema.version.unsupported', {
        version: String(rawVersion),
        supported: WORKFLOW_FORMAT_VERSION,
      });
    }
    schemaVersion = rawVersion;
  }

  // stateField must name a single-valued enum field with inline options
  const stateField = raw.stateField;
  if (typeof stateField !== 'string') {
    fail(vc, 'workflow.stateField.enum', { field: String(stateField) });
  }
  const field = fields.find((f) => f.name === stateField);
  if (
    field === undefined ||
    field.type !== FIELD_TYPES.ENUM ||
    (field as { multiple?: boolean }).multiple === true
  ) {
    fail(vc, 'workflow.stateField.enum', { field: stateField });
  }
  const options = (field as { options: unknown }).options;
  if (!Array.isArray(options)) {
    fail(vc, 'workflow.stateField.enum', { field: stateField });
  }
  const optionSet = new Set(options as string[]);

  // states: non-empty, unique snake_case names drawn from the state field options
  const rawStates = raw.states;
  if (!Array.isArray(rawStates) || rawStates.length === 0) fail(vc, 'workflow.states.required');
  const states: WorkflowState[] = [];
  const stateNames = new Set<string>();
  for (const entry of rawStates) {
    if (!isRecord(entry)) fail(vc, 'workflow.state.invalid', { value: String(entry) });
    const name = entry.name;
    if (typeof name !== 'string' || !SNAKE_CASE.test(name)) {
      fail(vc, 'workflow.state.invalid', { value: String(name) });
    }
    if (stateNames.has(name) || !optionSet.has(name)) {
      fail(vc, 'workflow.state.invalid', { value: name });
    }
    stateNames.add(name);
    const labels = validateLabels(entry.labels, vc);
    const description = entry.description === undefined ? undefined : String(entry.description);
    let onTimeout: WorkflowTimeout | undefined;
    if (entry.onTimeout !== undefined) {
      const rawTimeout = entry.onTimeout;
      if (!isRecord(rawTimeout)) fail(vc, 'workflow.timeout.invalid', { state: name });
      const after = rawTimeout.after;
      if (typeof after !== 'string' || parseDuration(after) === undefined) {
        fail(vc, 'workflow.timeout.invalid', { state: name });
      }
      let timeoutAction: string | undefined;
      if (rawTimeout.action !== undefined) {
        if (typeof rawTimeout.action !== 'string' || !SNAKE_CASE.test(rawTimeout.action)) {
          fail(vc, 'workflow.timeout.invalid', { state: name });
        }
        timeoutAction = rawTimeout.action;
      }
      onTimeout = { after, ...(timeoutAction === undefined ? {} : { action: timeoutAction }) };
    }
    states.push({
      name,
      ...(labels === undefined ? {} : { labels }),
      ...(description === undefined ? {} : { description }),
      ...(onTimeout === undefined ? {} : { onTimeout }),
    });
  }

  // transitions: non-empty, unique (from, action), known states
  const rawTransitions = raw.transitions;
  if (!Array.isArray(rawTransitions) || rawTransitions.length === 0) {
    fail(vc, 'workflow.transitions.required');
  }
  const transitions: WorkflowTransition[] = [];
  const seen = new Set<string>();
  rawTransitions.forEach((entry, index) => {
    const i = index + 1;
    if (!isRecord(entry)) fail(vc, 'workflow.transition.invalid', { i });
    const action = entry.action;
    const from = entry.from;
    const to = entry.to;
    if (
      typeof action !== 'string' ||
      !SNAKE_CASE.test(action) ||
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !stateNames.has(from) ||
      !stateNames.has(to) ||
      seen.has(`${from}\u0000${action}`)
    ) {
      fail(vc, 'workflow.transition.invalid', { i });
    }
    seen.add(`${from}\u0000${action}`);
    const labels = validateLabels(entry.labels, vc);
    let roles: string[] | undefined;
    if (entry.roles !== undefined) {
      if (
        !Array.isArray(entry.roles) ||
        !entry.roles.every((role) => typeof role === 'string' && role.length > 0)
      ) {
        fail(vc, 'workflow.transition.invalid', { i });
      }
      roles = entry.roles as string[];
    }
    let requiresApproval: boolean | undefined;
    if (entry.requiresApproval !== undefined) {
      if (typeof entry.requiresApproval !== 'boolean') fail(vc, 'workflow.transition.invalid', { i });
      requiresApproval = entry.requiresApproval;
    }
    transitions.push({
      action,
      from,
      to,
      ...(labels === undefined ? {} : { labels }),
      ...(roles === undefined ? {} : { roles }),
      ...(requiresApproval === undefined ? {} : { requiresApproval }),
    });
  });

  // a state's timeout action, when present, must be a declared transition from that state
  for (const state of states) {
    const timeoutAction = state.onTimeout?.action;
    if (
      timeoutAction !== undefined &&
      !transitions.some((t) => t.from === state.name && t.action === timeoutAction)
    ) {
      fail(vc, 'workflow.timeout.invalid', { state: state.name });
    }
  }

  // initial must be a declared state
  const initial = raw.initial;
  if (typeof initial !== 'string' || !stateNames.has(initial)) {
    fail(vc, 'workflow.initial.unknown', {
      value: typeof initial === 'string' ? initial : String(initial),
    });
  }

  return {
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    stateField,
    initial,
    states,
    transitions,
  };
}

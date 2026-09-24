import { describe, it, expect } from '../helpers/test.js';
import { validateObject, SchemaError } from '../../src/core/index.js';
import type { ObjectDefinition } from '../../src/core/index.js';

const STATES = ['draft', 'pending', 'approved', 'rejected'];

function objectWith(workflow: unknown): Record<string, unknown> {
  return {
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'status', type: 'enum', options: STATES },
    ],
    workflow,
  };
}

function validWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initial: 'draft',
    stateField: 'status',
    states: [{ name: 'draft' }, { name: 'pending' }, { name: 'approved' }, { name: 'rejected' }],
    transitions: [
      { action: 'submit', from: 'draft', to: 'pending' },
      { action: 'approve', from: 'pending', to: 'approved' },
      { action: 'reject', from: 'pending', to: 'rejected' },
    ],
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '(no error)';
  } catch (error) {
    return error instanceof SchemaError ? error.code : String(error);
  }
}

function def(workflow: unknown): ObjectDefinition {
  return validateObject(objectWith(workflow));
}

describe('validateWorkflow — declarative state machine on objects/<name>/workflow.json', () => {
  it('accepts a valid workflow and attaches it to the object', () => {
    const result = def(validWorkflow());
    expect(result.workflow?.stateField).toBe('status');
    expect(result.workflow?.initial).toBe('draft');
    expect(result.workflow?.states.map((s) => s.name)).toEqual(STATES);
    expect(result.workflow?.transitions).toHaveLength(3);
  });

  it('no workflow declared → undefined', () => {
    expect(def(undefined).workflow).toBeUndefined();
  });

  it('non-object workflow → workflow.notObject', () => {
    expect(codeOf(() => def('nope'))).toBe('workflow.notObject');
  });

  it('stateField missing / not an enum → workflow.stateField.enum', () => {
    expect(codeOf(() => def(validWorkflow({ stateField: 'title' })))).toBe('workflow.stateField.enum');
    expect(codeOf(() => def(validWorkflow({ stateField: 'nope' })))).toBe('workflow.stateField.enum');
  });

  it('states must be non-empty → workflow.states.required', () => {
    expect(codeOf(() => def(validWorkflow({ states: [] })))).toBe('workflow.states.required');
  });

  it('unknown or duplicate state → workflow.state.invalid', () => {
    expect(codeOf(() => def(validWorkflow({ states: [{ name: 'ghost' }] })))).toBe('workflow.state.invalid');
    expect(
      codeOf(() => def(validWorkflow({ states: [{ name: 'draft' }, { name: 'draft' }] }))),
    ).toBe('workflow.state.invalid');
  });

  it('transitions must be non-empty → workflow.transitions.required', () => {
    expect(codeOf(() => def(validWorkflow({ transitions: [] })))).toBe('workflow.transitions.required');
  });

  it('unknown from/to state or duplicate (from, action) → workflow.transition.invalid', () => {
    expect(
      codeOf(() =>
        def(validWorkflow({ transitions: [{ action: 'submit', from: 'draft', to: 'ghost' }] })),
      ),
    ).toBe('workflow.transition.invalid');
    expect(
      codeOf(() =>
        def(
          validWorkflow({
            transitions: [
              { action: 'submit', from: 'draft', to: 'pending' },
              { action: 'submit', from: 'draft', to: 'approved' },
            ],
          }),
        ),
      ),
    ).toBe('workflow.transition.invalid');
  });

  it('initial must be a declared state → workflow.initial.unknown', () => {
    expect(codeOf(() => def(validWorkflow({ initial: 'ghost' })))).toBe('workflow.initial.unknown');
  });

  it('future workflow schemaVersion → schema.version.unsupported', () => {
    expect(codeOf(() => def(validWorkflow({ schemaVersion: 99 })))).toBe('schema.version.unsupported');
  });

  it('accepts requiresApproval on a transition; rejects a non-boolean', () => {
    const ok = def(
      validWorkflow({ transitions: [{ action: 'submit', from: 'draft', to: 'pending', requiresApproval: true }] }),
    );
    expect(ok.workflow?.transitions[0]?.requiresApproval).toBe(true);
    expect(
      codeOf(() =>
        def(validWorkflow({ transitions: [{ action: 'submit', from: 'draft', to: 'pending', requiresApproval: 'yes' }] })),
      ),
    ).toBe('workflow.transition.invalid');
  });
});

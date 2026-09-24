import { describe, it, expect } from '../helpers/test.js';
import { validateObject, SchemaError, parseDuration, hashWorkflow, migrateWorkflowObject } from '../../src/core/index.js';
import type { ObjectDefinition } from '../../src/core/index.js';

const STATES = ['draft', 'pending', 'approved', 'rejected'];

function objectWith(workflow: unknown): Record<string, unknown> {
  return {
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'status', type: 'enum', options: STATES },
    ],
    ...(workflow === undefined ? {} : { workflowEnabled: true }),
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

  it('accepts a state onTimeout whose action is a transition from that state', () => {
    const ok = def(
      validWorkflow({
        states: [
          { name: 'draft', onTimeout: { after: '7d', action: 'submit' } },
          { name: 'pending' },
          { name: 'approved' },
          { name: 'rejected' },
        ],
      }),
    );
    expect(ok.workflow?.states.find((s) => s.name === 'draft')?.onTimeout?.after).toBe('7d');
  });

  it('rejects an invalid onTimeout duration or a non-transition action', () => {
    expect(
      codeOf(() =>
        def(
          validWorkflow({
            states: [{ name: 'draft', onTimeout: { after: 'soon' } }, { name: 'pending' }, { name: 'approved' }, { name: 'rejected' }],
          }),
        ),
      ),
    ).toBe('workflow.timeout.invalid');
    expect(
      codeOf(() =>
        def(
          validWorkflow({
            states: [{ name: 'draft', onTimeout: { after: '7d', action: 'approve' } }, { name: 'pending' }, { name: 'approved' }, { name: 'rejected' }],
          }),
        ),
      ),
    ).toBe('workflow.timeout.invalid');
  });
});

describe('workflowEnabled — the schema.json opt-in switch', () => {
  function bare(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'status', type: 'enum', options: STATES },
      ],
      ...extra,
    };
  }

  it('absent switch → a declared workflow is ignored (disabled)', () => {
    expect(validateObject(bare({ workflow: validWorkflow() })).workflow).toBeUndefined();
  });

  it('workflowEnabled: false → ignored but reported', () => {
    const result = validateObject(bare({ workflowEnabled: false, workflow: validWorkflow() }));
    expect(result.workflow).toBeUndefined();
    expect(result.workflowEnabled).toBe(false);
  });

  it('workflowEnabled: true → validated and attached', () => {
    const result = validateObject(bare({ workflowEnabled: true, workflow: validWorkflow() }));
    expect(result.workflowEnabled).toBe(true);
    expect(result.workflow?.stateField).toBe('status');
  });

  it('workflowEnabled: true without a definition → workflow.definition.missing', () => {
    expect(codeOf(() => validateObject(bare({ workflowEnabled: true })))).toBe(
      'workflow.definition.missing',
    );
  });

  it('non-boolean workflowEnabled → object.workflowEnabled.boolean', () => {
    expect(codeOf(() => validateObject(bare({ workflowEnabled: 'yes' })))).toBe(
      'object.workflowEnabled.boolean',
    );
  });
});

describe('workflow definition identity (version + semantic hash)', () => {
  it('attaches a stable hash and matches the exported helper', () => {
    const result = def(validWorkflow());
    expect(result.workflowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWorkflow(result.workflow!)).toBe(result.workflowHash);
    expect(def(validWorkflow()).workflowHash).toBe(result.workflowHash);
  });

  it('changes when runtime semantics change, not when the format version changes', () => {
    const base = def(validWorkflow()).workflowHash;
    expect(def(validWorkflow({ schemaVersion: 1 })).workflowHash).toBe(base);
    const withRoles = def(
      validWorkflow({
        transitions: [
          { action: 'submit', from: 'draft', to: 'pending', roles: ['manager'] },
          { action: 'approve', from: 'pending', to: 'approved' },
          { action: 'reject', from: 'pending', to: 'rejected' },
        ],
      }),
    ).workflowHash;
    expect(withRoles).not.toBe(base);
    expect(def(validWorkflow({ version: 2 })).workflowHash).not.toBe(base);
  });

  it('rejects a non-positive-integer version → workflow.version.invalid', () => {
    expect(codeOf(() => def(validWorkflow({ version: 0 })))).toBe('workflow.version.invalid');
    expect(codeOf(() => def(validWorkflow({ version: 1.5 })))).toBe('workflow.version.invalid');
    expect(codeOf(() => def(validWorkflow({ version: 'v2' })))).toBe('workflow.version.invalid');
  });
});

describe('workflow migrations (evolution remap DSL)', () => {
  function withMigrations(migrations: unknown): Record<string, unknown> {
    return {
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'status', type: 'enum', options: [...STATES, 'old'] },
      ],
      workflowEnabled: true,
      workflow: validWorkflow({ migrations }),
    };
  }

  it('accepts a remap from a removed enum option to a live state', () => {
    const result = validateObject(withMigrations([{ from: 'old', to: 'draft' }]));
    expect(result.workflow?.migrations).toEqual([{ from: 'old', to: 'draft' }]);
  });

  it('rejects a bad target, a live `from`, an unknown `from`, or a duplicate', () => {
    expect(codeOf(() => validateObject(withMigrations([{ from: 'old', to: 'ghost' }])))).toBe(
      'workflow.migrations.invalid',
    );
    expect(codeOf(() => validateObject(withMigrations([{ from: 'draft', to: 'approved' }])))).toBe(
      'workflow.migrations.invalid',
    );
    expect(codeOf(() => validateObject(withMigrations([{ from: 'ghost', to: 'draft' }])))).toBe(
      'workflow.migrations.invalid',
    );
    expect(
      codeOf(() =>
        validateObject(
          withMigrations([
            { from: 'old', to: 'draft' },
            { from: 'old', to: 'pending' },
          ]),
        ),
      ),
    ).toBe('workflow.migrations.invalid');
  });
});

describe('workflow.json format migrations', () => {
  it('stamps an unversioned file up to the current format', () => {
    const { workflow, from, migrated } = migrateWorkflowObject({ stateField: 'status', initial: 'draft' });
    expect(from).toBe(0);
    expect(migrated).toBe(true);
    expect(workflow.schemaVersion).toBe(1);
  });

  it('is a no-op at the current version and rejects a future one', () => {
    expect(migrateWorkflowObject({ schemaVersion: 1, stateField: 'status' }).migrated).toBe(false);
    expect(codeOf(() => migrateWorkflowObject({ schemaVersion: 99 }))).toBe('schema.version.unsupported');
  });
});

describe('parseDuration', () => {
  it('parses units and bare milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('2w')).toBe(1_209_600_000);
    expect(parseDuration('250')).toBe(250);
  });

  it('rejects invalid / non-positive durations', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('0s')).toBeUndefined();
    expect(parseDuration('1x')).toBeUndefined();
    expect(parseDuration('-5s')).toBeUndefined();
    expect(parseDuration('1.5h')).toBeUndefined();
  });
});

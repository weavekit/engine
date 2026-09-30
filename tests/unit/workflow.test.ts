import { describe, it, expect } from '../helpers/test.js';
import { validateObject, SchemaError, parseDuration, hashWorkflow, migrateWorkflowObject, parseObject } from '../../src/core/index.js';
import type { ObjectDefinition } from '../../src/core/index.js';

function objectWith(workflow: unknown): Record<string, unknown> {
  return {
    name: 'lead',
    fields: [{ name: 'id', type: 'string', primary: true }],
    ...(workflow === undefined ? {} : { workflowEnabled: true }),
    workflow,
  };
}

function validWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: [
      { id: 'review', assign: { roles: ['reviewer'] } },
      { id: 'approve', assign: { roles: ['manager'], mode: 'all' } },
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

describe('validateWorkflow — single-line node chain on objects/<name>/workflow.json', () => {
  it('accepts a valid workflow and attaches the node chain', () => {
    const result = def(validWorkflow());
    expect(result.workflow?.nodes.map((n) => n.id)).toEqual(['review', 'approve']);
    expect(result.workflow?.nodes[1]?.assign.roles).toEqual(['manager']);
    expect(result.workflow?.nodes[1]?.assign.mode).toBe('all');
  });

  it('no workflow declared → undefined', () => {
    expect(def(undefined).workflow).toBeUndefined();
  });

  it('non-object workflow → workflow.notObject', () => {
    expect(codeOf(() => def('nope'))).toBe('workflow.notObject');
  });

  it('empty or missing nodes → workflow.nodes.required', () => {
    expect(codeOf(() => def(validWorkflow({ nodes: [] })))).toBe('workflow.nodes.required');
    expect(codeOf(() => def({}))).toBe('workflow.nodes.required');
  });

  it('bad or duplicate node id → workflow.node.invalid', () => {
    expect(codeOf(() => def(validWorkflow({ nodes: [{ id: 'Bad' }, { id: 'Bad' }] })))).toBe('workflow.node.invalid');
    expect(
      codeOf(() => def(validWorkflow({ nodes: [{ id: 'a' }, { id: 'a' }] }))),
    ).toBe('workflow.node.invalid');
  });

  it('unknown kind → workflow.node.invalid', () => {
    expect(
      codeOf(() => def(validWorkflow({ nodes: [{ id: 'a', kind: 'branch', assign: { roles: ['r'] } }] }))),
    ).toBe('workflow.node.invalid');
  });

  it('missing/empty assign.roles → workflow.node.invalid', () => {
    expect(codeOf(() => def(validWorkflow({ nodes: [{ id: 'a' }] })))).toBe('workflow.node.invalid');
    expect(
      codeOf(() => def(validWorkflow({ nodes: [{ id: 'a', assign: { roles: [] } }] }))),
    ).toBe('workflow.node.invalid');
  });

  it('invalid assign.mode → workflow.node.invalid', () => {
    expect(
      codeOf(() => def(validWorkflow({ nodes: [{ id: 'a', assign: { roles: ['r'], mode: 'some' } }] }))),
    ).toBe('workflow.node.invalid');
  });

  it('notify node with 会签 (all) → workflow.node.invalid', () => {
    expect(
      codeOf(() =>
        def(validWorkflow({ nodes: [{ id: 'cc', kind: 'notify', assign: { roles: ['r'], mode: 'all' } }] })),
      ),
    ).toBe('workflow.node.invalid');
  });

  it('rollback targets must name an earlier node → workflow.rollback.notEarlier', () => {
    expect(
      codeOf(() =>
        def(
          validWorkflow({
            nodes: [
              { id: 'first', assign: { roles: ['r'] }, onReject: 'second' },
              { id: 'second', assign: { roles: ['r'] } },
            ],
          }),
        ),
      ),
    ).toBe('workflow.rollback.notEarlier');
    expect(
      codeOf(() =>
        def(
          validWorkflow({
            nodes: [
              { id: 'first', assign: { roles: ['r'] }, onWithdraw: 'ghost' },
              { id: 'second', assign: { roles: ['r'] } },
            ],
          }),
        ),
      ),
    ).toBe('workflow.rollback.notEarlier');
  });

  it('accepts an earlier rollback target', () => {
    const result = def(
      validWorkflow({
        nodes: [
          { id: 'first', assign: { roles: ['r'] } },
          { id: 'second', assign: { roles: ['r'] }, onReject: 'first', onWithdraw: 'first' },
        ],
      }),
    );
    expect(result.workflow?.nodes[1]).toMatchObject({ onReject: 'first', onWithdraw: 'first' });
  });

  it('future workflow schemaVersion → schema.version.unsupported', () => {
    expect(codeOf(() => def(validWorkflow({ schemaVersion: 99 })))).toBe('schema.version.unsupported');
  });

  it('accepts a node onTimeout with a valid duration + action', () => {
    const ok = def(
      validWorkflow({
        nodes: [{ id: 'review', assign: { roles: ['r'] }, onTimeout: { after: '7d', action: 'reject' } }],
      }),
    );
    expect(ok.workflow?.nodes[0]?.onTimeout?.after).toBe('7d');
    expect(ok.workflow?.nodes[0]?.onTimeout?.action).toBe('reject');
  });

  it('rejects an invalid onTimeout (duration / action / notify node)', () => {
    const bad = (onTimeout: unknown): string =>
      codeOf(() => def(validWorkflow({ nodes: [{ id: 'review', assign: { roles: ['r'] }, onTimeout }] })));
    expect(bad({ after: 'soon' })).toBe('workflow.timeout.invalid');
    expect(bad({ after: '7d', action: 'submit' })).toBe('workflow.timeout.invalid');
    expect(
      codeOf(() =>
        def(validWorkflow({ nodes: [{ id: 'cc', kind: 'notify', assign: { roles: ['r'] }, onTimeout: { after: '7d' } }] })),
      ),
    ).toBe('workflow.timeout.invalid');
  });

  it('rejects a non-positive-integer version → workflow.version.invalid', () => {
    expect(codeOf(() => def(validWorkflow({ version: 0 })))).toBe('workflow.version.invalid');
    expect(codeOf(() => def(validWorkflow({ version: 1.5 })))).toBe('workflow.version.invalid');
    expect(codeOf(() => def(validWorkflow({ version: 'v2' })))).toBe('workflow.version.invalid');
  });
});

describe('workflowEnabled — the schema.json opt-in switch', () => {
  function bare(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'lead',
      fields: [{ name: 'id', type: 'string', primary: true }],
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
    expect(result.workflow?.nodes).toHaveLength(2);
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
        nodes: [
          { id: 'review', assign: { roles: ['reviewer'] } },
          { id: 'approve', assign: { roles: ['director'], mode: 'all' } },
        ],
      }),
    ).workflowHash;
    expect(withRoles).not.toBe(base);
    expect(def(validWorkflow({ version: 2 })).workflowHash).not.toBe(base);
  });
});

describe('workflow.json format migrations', () => {
  it('linearizes a v1 state machine into a node chain', () => {
    const { workflow, from, migrated } = migrateWorkflowObject({
      stateField: 'status',
      initial: 'draft',
      states: [{ name: 'draft' }, { name: 'pending' }, { name: 'approved' }],
      transitions: [
        { action: 'submit', from: 'draft', to: 'pending', roles: ['reviewer'] },
        { action: 'approve', from: 'pending', to: 'approved', roles: ['manager'] },
        { action: 'reject', from: 'pending', to: 'draft' },
      ],
    });
    expect(from).toBe(0);
    expect(migrated).toBe(true);
    expect(workflow.schemaVersion).toBe(2);
    expect((workflow.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(['pending', 'approved']);
  });

  it('is a no-op at the current version and rejects a future one', () => {
    expect(migrateWorkflowObject({ schemaVersion: 2, nodes: [] }).migrated).toBe(false);
    expect(codeOf(() => migrateWorkflowObject({ schemaVersion: 99 }))).toBe('schema.version.unsupported');
  });

  it('infers v2 from a nodes[] chain that omits schemaVersion', () => {
    const nodes = [{ id: 'review', assign: { roles: ['reviewer'] } }];
    const { workflow, from, migrated } = migrateWorkflowObject({ nodes });
    expect(from).toBe(2);
    expect(migrated).toBe(false);
    expect(workflow.schemaVersion).toBeUndefined();
    expect(workflow.nodes).toEqual(nodes);
  });

  it('still treats an unversioned state machine as legacy 0', () => {
    const { from, migrated } = migrateWorkflowObject({
      stateField: 'status',
      initial: 'draft',
      states: [{ name: 'draft' }, { name: 'pending' }],
      transitions: [{ action: 'submit', from: 'draft', to: 'pending', roles: ['reviewer'] }],
    });
    expect(from).toBe(0);
    expect(migrated).toBe(true);
  });

  it('the loader keeps a nodes[] chain when schemaVersion is omitted', () => {
    const schema = JSON.stringify({
      name: 'lead',
      workflowEnabled: true,
      fields: [{ name: 'id', type: 'string', primary: true }],
    });
    const workflow = JSON.stringify({ nodes: [{ id: 'review', assign: { roles: ['reviewer'] } }] });
    const parsed = parseObject(schema, workflow);
    expect(parsed.workflow?.nodes.map((n) => n.id)).toEqual(['review']);
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

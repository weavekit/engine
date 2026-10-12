import { describe, it, expect } from '../helpers/test.js';
import {
  ObjectRegistry,
  OBJECT_RLS_POLICIES,
  buildObjectRlsPolicies,
  buildRlsPolicy,
  diffObjectRls,
  diffRls,
  planObjectRls,
  rlsPolicyComment,
  type ActualTable,
  type ObjectDefinition,
} from '../../src/core/index.js';

const ACTOR = "NULLIF(current_setting('weavekit.actor_id', true), '')";
const DEPT = "NULLIF(current_setting('weavekit.department_id', true), '')";
const SCOPE = "NULLIF(current_setting('weavekit.scope_id', true), '')";

function registryOf(...defs: ObjectDefinition[]): ObjectRegistry {
  const registry = new ObjectRegistry();
  for (const def of defs) registry.register(def);
  registry.buildGraph();
  return registry;
}

const DOC: ObjectDefinition = {
  name: 'doc',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'owner_id', type: 'string', ownership: true },
    { name: 'dept_id', type: 'string', department: true },
  ],
  permissions: {
    writer: { read: 'own' },
    lead: { read: 'department' },
    editor: { read: 'all', manage: 'own' },
  },
};

const byName = (policies: ReturnType<typeof buildObjectRlsPolicies>) => new Map(policies.map((p) => [p.name, p]));

describe('object-path RLS policies mirror the application row scope', () => {
  it('own / department subtree / all, role-gated, over the subject GUCs', () => {
    const reg = registryOf(DOC);
    const policies = byName(buildObjectRlsPolicies(reg, reg.get('doc')!));
    const select = policies.get(OBJECT_RLS_POLICIES.SELECT)!.using;
    expect(select).toContain(`"owner_id" = ${ACTOR}`);
    expect(select).toContain('WITH RECURSIVE sub');
    expect(select).toContain(DEPT);
    expect(select).toContain("'editor' = ANY (string_to_array(current_setting('weavekit.roles', true), ','))");
    expect(select).not.toContain('$1');
  });

  it('SELECT covers read ∪ manage; UPDATE/DELETE use the manage scope only', () => {
    const reg = registryOf(DOC);
    const policies = byName(buildObjectRlsPolicies(reg, reg.get('doc')!));
    const editorClause = "'editor' = ANY (string_to_array(current_setting('weavekit.roles', true), ','))";
    expect(policies.get(OBJECT_RLS_POLICIES.SELECT)!.using).toContain(`${editorClause} OR`);
    expect(policies.get(OBJECT_RLS_POLICIES.UPDATE)!.using).toContain(`(${editorClause} AND ("owner_id" = ${ACTOR}))`);
    expect(policies.get(OBJECT_RLS_POLICIES.UPDATE)!.check).toBe('true');
    expect(policies.get(OBJECT_RLS_POLICIES.DELETE)!.using).toBe(policies.get(OBJECT_RLS_POLICIES.UPDATE)!.using);
  });

  it('a scope column bounds scoped subjects only (scope-less subjects pass, like buildRowScope)', () => {
    const reg = registryOf({
      name: 'acct',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'org', type: 'string', scope: true },
      ],
      permissions: { member: { read: 'all' } },
    });
    const policies = byName(buildObjectRlsPolicies(reg, reg.get('acct')!));
    const bound = `(${SCOPE} IS NULL OR "org" = ${SCOPE})`;
    expect(policies.get(OBJECT_RLS_POLICIES.SELECT)!.using).toContain(bound);
    expect(policies.get(OBJECT_RLS_POLICIES.UPDATE)!.check).toBe(bound);
  });

  it('open mode (no permissions) needs no role; a details child is scoped through its parent', () => {
    const reg = registryOf(
      {
        name: 'order_head',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'owner_id', type: 'string', ownership: true },
          { name: 'lines', type: 'details', target: 'order_line' },
        ],
        permissions: { rep: { read: 'own', update: true } },
      },
      { name: 'order_line', fields: [{ name: 'id', type: 'string', primary: true }] },
      { name: 'note', fields: [{ name: 'id', type: 'string', primary: true }] },
    );
    expect(byName(buildObjectRlsPolicies(reg, reg.get('note')!)).get(OBJECT_RLS_POLICIES.SELECT)!.using).toBe('true');
    const child = byName(buildObjectRlsPolicies(reg, reg.get('order_line')!)).get(OBJECT_RLS_POLICIES.SELECT)!.using;
    expect(child).toContain('EXISTS (SELECT 1 FROM "order_head" p WHERE');
    expect(child).toContain(`p."owner_id" = ${ACTOR}`);
  });

  it('no readable role → no policy (RLS denies everything)', () => {
    const reg = registryOf({ name: 'locked', fields: [{ name: 'id', type: 'string', primary: true }], permissions: { x: { create: true } } });
    expect(buildObjectRlsPolicies(reg, reg.get('locked')!)).toEqual([]);
  });
});

describe('object-path RLS diff is drift-aware and idempotent', () => {
  const reg = registryOf(DOC);
  const policies = buildObjectRlsPolicies(reg, reg.get('doc')!);
  const commentOf = (p: (typeof policies)[number]) => rlsPolicyComment(`${p.command}|weavekit_object|${p.using}|${p.check ?? ''}`);
  const provisioned = (): ActualTable => ({
    name: 'doc',
    columns: [],
    pk: ['id'],
    fks: [],
    indexNames: [],
    rlsEnabled: true,
    rlsPolicies: policies.map((p) => p.name),
    rlsPolicyComments: Object.fromEntries(policies.map((p) => [p.name, commentOf(p)])),
    grants: { weavekit_object: ['SELECT', 'UPDATE', 'DELETE'] },
  });

  it('a fresh table gets RLS + every policy (with its digest comment) + grants', () => {
    const stmts = diffObjectRls('doc', undefined, 'weavekit_object', policies, ['SELECT', 'UPDATE', 'DELETE']);
    expect(stmts[0]).toBe('ALTER TABLE "doc" ENABLE ROW LEVEL SECURITY;');
    expect(stmts.filter((s) => s.startsWith('CREATE POLICY')).length).toBe(3);
    expect(stmts.some((s) => s.includes('FOR UPDATE TO "weavekit_object"') && s.includes('WITH CHECK (true)'))).toBe(true);
    expect(stmts.filter((s) => s.startsWith('COMMENT ON POLICY')).length).toBe(3);
    expect(stmts[stmts.length - 1]).toBe('GRANT SELECT, UPDATE, DELETE ON "doc" TO "weavekit_object";');
  });

  it('an in-sync table yields no statements', () => {
    expect(diffObjectRls('doc', provisioned(), 'weavekit_object', policies, ['SELECT', 'UPDATE', 'DELETE'])).toEqual([]);
  });

  it('a changed predicate (stale digest) is recreated; a stale object policy is dropped', () => {
    const actual = provisioned();
    actual.rlsPolicyComments![OBJECT_RLS_POLICIES.SELECT] = 'weavekit:stale';
    actual.rlsPolicies!.push('weavekit_obj_legacy');
    const stmts = diffObjectRls('doc', actual, 'weavekit_object', policies, ['SELECT', 'UPDATE', 'DELETE']);
    expect(stmts).toContain('DROP POLICY IF EXISTS weavekit_obj_legacy ON "doc";');
    expect(stmts).toContain(`DROP POLICY IF EXISTS ${OBJECT_RLS_POLICIES.SELECT} ON "doc";`);
    expect(stmts.filter((s) => s.startsWith('CREATE POLICY')).length).toBe(1);
  });

  it('script read policy: a changed permission matrix is detected via the comment digest', () => {
    const def = reg.get('doc')!;
    const expected = buildRlsPolicy(def)!;
    const base: ActualTable = {
      name: 'doc', columns: [], pk: ['id'], fks: [], indexNames: [],
      rlsEnabled: true, rlsPolicies: ['weavekit_read_doc'], selectGrantedTo: ['weavekit_query'],
      rlsPolicyComments: { weavekit_read_doc: rlsPolicyComment(expected) },
    };
    expect(diffRls(def, base, 'weavekit_query')).toEqual([]);
    const stale = { ...base, rlsPolicyComments: { weavekit_read_doc: null } };
    expect(diffRls(def, stale, 'weavekit_query').some((s) => s.startsWith('CREATE POLICY weavekit_read_doc'))).toBe(true);
  });

  it('planObjectRls skips existing tables that did not opt into alter (migrate), but plans them in check mode', () => {
    const actual = new Map<string, ActualTable>([['doc', { ...provisioned(), rlsEnabled: false, owner: 'app' }]]);
    expect(planObjectRls(reg, actual, 'weavekit_object', { owner: 'app' }).skipped).toEqual(['doc']);
    const check = planObjectRls(reg, actual, 'weavekit_object');
    expect(check.skipped).toEqual([]);
    expect(check.statements).toContain('ALTER TABLE "doc" ENABLE ROW LEVEL SECURITY;');
  });
});

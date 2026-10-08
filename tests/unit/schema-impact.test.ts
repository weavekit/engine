import { describe, it, expect } from '../helpers/test.js';
import { analyzeImpact, IMPACT_RISKS, ROW_SCOPE_MARKERS, type ObjectDefinition } from '../../src/core/index.js';

const def = (name: string, over: Partial<ObjectDefinition> = {}): ObjectDefinition =>
  ({ name, fields: [{ name: 'id', type: 'string', primary: true }], ...over }) as ObjectDefinition;

describe('analyzeImpact — schema impact classification', () => {
  it('classifies a new table as a create (low risk)', () => {
    const impact = analyzeImpact(
      ['CREATE TABLE "lead" (\n  "id" VARCHAR(255) NOT NULL,\n  CONSTRAINT "lead_pkey" PRIMARY KEY ("id")\n);'],
      [def('lead')],
    );
    expect(impact.creates).toEqual(['lead']);
    expect(impact.dataCompat.risk).toBe(IMPACT_RISKS.LOW);
    expect(impact.apiBreaking).toBe(false);
  });

  it('flags ADD COLUMN NOT NULL without DEFAULT as high risk', () => {
    const impact = analyzeImpact(
      ['ALTER TABLE "lead" ADD COLUMN "name" VARCHAR(255) NOT NULL;'],
      [def('lead')],
    );
    expect(impact.columnAdds).toEqual([{ object: 'lead', column: 'name', notNullWithoutDefault: true }]);
    expect(impact.dataCompat.risk).toBe(IMPACT_RISKS.HIGH);
    expect(impact.dataCompat.notes.join(' ')).toContain('NOT NULL without DEFAULT');
  });

  it('an additive column with DEFAULT is medium (not breaking)', () => {
    const impact = analyzeImpact(
      ['ALTER TABLE "lead" ADD COLUMN "score" INTEGER DEFAULT 0;'],
      [def('lead')],
    );
    expect(impact.columnAdds[0]?.notNullWithoutDefault).toBe(false);
    expect(impact.dataCompat.risk).toBe(IMPACT_RISKS.MEDIUM);
    expect(impact.apiBreaking).toBe(false);
  });

  it('collects constraints, indexes, enum + RLS changes', () => {
    const impact = analyzeImpact(
      [
        'ALTER TABLE "lead" ADD CONSTRAINT "lead_pkey" PRIMARY KEY ("id");',
        'CREATE INDEX "lead_name_idx" ON "lead" ("name");',
        'ALTER TYPE "status" ADD VALUE IF NOT EXISTS \'done\';',
        'ALTER TABLE "lead" ENABLE ROW LEVEL SECURITY;',
        'CREATE POLICY weavekit_read_lead ON "lead" FOR SELECT USING (true);',
      ],
      [def('lead')],
    );
    expect(impact.constraints).toEqual(['lead_pkey']);
    expect(impact.indexes).toEqual(['lead_name_idx']);
    expect(impact.enumChanges).toEqual(['status']);
    expect(impact.rlsChanges.length).toBe(2);
    expect(impact.dataCompat.risk).toBe(IMPACT_RISKS.MEDIUM);
  });

  it('detects destructive DDL and marks it API-breaking + high risk', () => {
    const impact = analyzeImpact(['DROP TABLE "lead";'], [def('lead')]);
    expect(impact.drops).toEqual(['DROP TABLE "lead";']);
    expect(impact.apiBreaking).toBe(true);
    expect(impact.dataCompat.risk).toBe(IMPACT_RISKS.HIGH);
  });

  it('reports tenant-scoped and permissioned changed objects', () => {
    const tenantDef = def('invoice', {
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tenant_id', type: 'string', [ROW_SCOPE_MARKERS.TENANT]: true },
      ],
      permissions: { admin: { read: 'all' } },
    } as Partial<ObjectDefinition>);
    const impact = analyzeImpact(['ALTER TABLE "invoice" ADD COLUMN "amount" NUMERIC;'], [tenantDef]);
    expect(impact.rbacTenant.tenantObjects).toEqual(['invoice']);
    expect(impact.rbacTenant.permissionObjects).toEqual(['invoice']);
  });
});

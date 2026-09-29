import { describe, it, expect } from '../helpers/test.js';
import {
  ObjectRegistry,
  buildLinkTable,
  isLinkTable,
  linkTableName,
  type FieldDefinition,
} from '../../src/index.js';

type MultiRel = Extract<FieldDefinition, { type: 'multiRelation' }>;

function multiField(reg: ObjectRegistry, object: string, field: string): MultiRel {
  return reg.get(object)!.fields.find((f) => f.name === field) as MultiRel;
}

describe('multiRelation link tables — DDL spec', () => {
  it('single-column keys: PK-mirror columns + a FK per side (cascade) + target index', () => {
    const reg = new ObjectRegistry();
    reg.register({ name: 'tag', fields: [{ name: 'id', type: 'string', primary: true }] });
    reg.register({
      name: 'post',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'tag_ids', type: 'multiRelation', target: 'tag' },
      ],
    });
    const table = buildLinkTable(reg.get('post')!, multiField(reg, 'post', 'tag_ids'), reg.get('tag')!);

    expect(table.name).toBe(linkTableName('post', 'tag_ids'));
    expect(isLinkTable(table.name)).toBe(true);
    expect(table.columns.map((c) => c.name)).toEqual(['owner_id', 'target_id', 'idx']);
    expect(table.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['owner_id', 'target_id']);
    expect(table.fks).toEqual([
      { columns: ['owner_id'], refTable: 'post', refColumns: ['id'], onDelete: 'cascade' },
      { columns: ['target_id'], refTable: 'tag', refColumns: ['id'], onDelete: 'cascade' },
    ]);
    expect(table.indexes).toEqual([{ name: `${table.name}_target_idx`, method: 'btree', columns: ['target_id'] }]);
  });

  it('composite keys: multi-column FK on both sides', () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'pair',
      fields: [
        { name: 'a', type: 'string', primary: true },
        { name: 'b', type: 'string', primary: true },
      ],
    });
    reg.register({
      name: 'bundle',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'pair_ids', type: 'multiRelation', target: 'pair' },
      ],
    });
    const table = buildLinkTable(reg.get('bundle')!, multiField(reg, 'bundle', 'pair_ids'), reg.get('pair')!);
    expect(table.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['owner_id', 'target_a', 'target_b']);
    expect(table.fks).toContainEqual({
      columns: ['target_a', 'target_b'],
      refTable: 'pair',
      refColumns: ['a', 'b'],
      onDelete: 'cascade',
    });
  });
});

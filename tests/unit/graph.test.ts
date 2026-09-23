import { describe, it, expect } from '../helpers/test.js';import { ObjectRegistry, RELATION_KINDS } from '../../src/core/index.js';
import type { RelationEdge } from '../../src/core/index.js';

function registryOf(entries: Record<string, unknown>): ObjectRegistry {
  const reg = new ObjectRegistry();
  for (const def of Object.values(entries)) {
    reg.register(def);
  }
  return reg;
}

describe('buildGraph — relation weak references', () => {
  it('belongsTo infers reverse hasMany', () => {
    const reg = registryOf({
      purchase_order: {
        name: 'purchase_order',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
      purchase_order_line: {
        name: 'purchase_order_line',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'order_id', type: 'relation', target: 'purchase_order', required: true },
        ],
      },
    });
    const graph = reg.buildGraph();

    const lineBelongsTo = graph.belongsToFrom('purchase_order_line');
    expect(lineBelongsTo).toHaveLength(1);
    expect(lineBelongsTo[0]).toMatchObject({
      kind: RELATION_KINDS.BELONGS_TO,
      target: 'purchase_order',
      foreignKey: 'order_id',
      required: true,
    });

    const orderHasMany = graph.hasManyFrom('purchase_order');
    expect(orderHasMany).toHaveLength(1);
    expect(orderHasMany[0]).toMatchObject({
      kind: RELATION_KINDS.HAS_MANY,
      target: 'purchase_order_line',
      foreignKey: 'order_id',
    });
  });

  it('relation target missing rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'b_id', type: 'relation', target: 'ghost' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/points to missing target/);
  });
});

describe('buildGraph — details strong ownership', () => {
  it('details generates child-table edge + reverse belongsTo + reserved column check', () => {
    const reg = registryOf({
      purchase_order: {
        name: 'purchase_order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'purchase_order_line' },
        ],
      },
      purchase_order_line: {
        name: 'purchase_order_line',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
    });
    const graph = reg.buildGraph();

    const orderHasMany = graph.hasManyFrom('purchase_order');
    expect(orderHasMany).toHaveLength(1);
    expect(orderHasMany[0]).toMatchObject({
      kind: RELATION_KINDS.HAS_MANY,
      target: 'purchase_order_line',
      foreignKey: 'parent_id',
      details: true,
    });

    const lineBelongsTo = graph.belongsToFrom('purchase_order_line');
    expect(lineBelongsTo).toHaveLength(1);
    expect(lineBelongsTo[0]).toMatchObject({
      kind: RELATION_KINDS.BELONGS_TO,
      target: 'purchase_order',
      foreignKey: 'parent_id',
      details: true,
    });
  });

  it('details pointing to itself rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'children', type: 'details', target: 'a' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/cannot point to itself/);
  });

  it('details target missing rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'items', type: 'details', target: 'ghost' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/points to missing child/);
  });

  it('parent object primary key must be string', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'integer', primary: true },
          { name: 'items', type: 'details', target: 'b' },
        ],
      },
      b: {
        name: 'b',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/must be of string type/);
  });

  it('child object declaring reserved column rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'items', type: 'details', target: 'b' },
        ],
      },
      b: {
        name: 'b',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'parent_id', type: 'string' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/cannot declare reserved column/);
  });

  it('same child object referenced by multiple parents (multi-parent reuse)', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'attachments', type: 'details', target: 'attachment' },
        ],
      },
      invoice: {
        name: 'invoice',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'attachments', type: 'details', target: 'attachment' },
        ],
      },
      attachment: {
        name: 'attachment',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
    });
    const graph = reg.buildGraph();
    expect(graph.hasManyFrom('order')).toHaveLength(1);
    expect(graph.hasManyFrom('invoice')).toHaveLength(1);
    expect(graph.belongsToFrom('attachment')).toHaveLength(2);
  });
});

describe('buildGraph — N:M explicit join object', () => {
  it('join object infers hasMany on both sides', () => {
    const reg = registryOf({
      tag: {
        name: 'tag',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
      purchase_order: {
        name: 'purchase_order',
        fields: [{ name: 'id', type: 'string', primary: true }],
      },
      purchase_order_tag: {
        name: 'purchase_order_tag',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'purchase_order_id', type: 'relation', target: 'purchase_order', required: true },
          { name: 'tag_id', type: 'relation', target: 'tag', required: true },
        ],
      },
    });
    const graph = reg.buildGraph();
    expect(graph.hasManyFrom('purchase_order')).toHaveLength(1);
    expect(graph.hasManyFrom('tag')).toHaveLength(1);
    expect(graph.belongsToFrom('purchase_order_tag')).toHaveLength(2);

    const edges: RelationEdge[] = graph.edges;
    expect(edges).toHaveLength(4);
  });
});

describe('buildGraph — multiRelation multi-select references', () => {
  it('forward multiRelation edge + reverse hasMany (array)', () => {
    const reg = registryOf({
      contact: {
        name: 'contact',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'name', type: 'string', required: true },
        ],
      },
      customer: {
        name: 'customer',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'name', type: 'string' },
          { name: 'contacts', type: 'multiRelation', target: 'contact', required: true },
        ],
      },
    });
    const graph = reg.buildGraph();

    const fwd = graph.multiRelationFrom('customer');
    expect(fwd).toHaveLength(1);
    expect(fwd[0]).toMatchObject({
      kind: RELATION_KINDS.MULTI_RELATION,
      target: 'contact',
      foreignKey: 'contacts',
      required: true,
    });

    const reverse = graph.hasManyFrom('contact');
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({
      kind: RELATION_KINDS.HAS_MANY,
      target: 'customer',
      foreignKey: 'contacts',
      array: true,
    });
  });

  it('multiRelation pointing to itself rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'friends', type: 'multiRelation', target: 'a' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/cannot point to itself/);
  });

  it('multiRelation target missing rejected', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'xs', type: 'multiRelation', target: 'ghost' },
        ],
      },
    });
    expect(() => reg.buildGraph()).toThrow(/points to missing target/);
  });
});

describe('buildGraph — cross-object formula cycle', () => {
  it('two object formulas reference each other → formula.cycle', () => {
    const reg = registryOf({
      a: {
        name: 'a',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'b_id', type: 'relation', target: 'b' },
          { name: 'fa', type: 'string', formula: 'b_id.bx' },
        ],
      },
      b: {
        name: 'b',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'a_id', type: 'relation', target: 'a' },
          { name: 'bx', type: 'string', formula: 'a_id.fa' },
        ],
      },
    });
    // a.fa → b.bx → a.fa: the cross-object formula chain forms a cycle across
    // two hops — buildGraph must detect it via the formula→formula edges
    expect(() => reg.buildGraph()).toThrow(/formula cycle/);
  });

  it('details aggregate (child field non-formula) → no false cycle', () => {
    const reg = registryOf({
      order: {
        name: 'order',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'lines', type: 'details', target: 'line' },
          { name: 'total', type: 'integer', formula: 'SUM(lines.amount)' },
        ],
      },
      line: {
        name: 'line',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'amount', type: 'integer' },
        ],
      },
    });
    // legal one-directional details aggregate — must not report a cycle
    expect(() => reg.buildGraph()).not.toThrow();
  });
});

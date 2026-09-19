import { describe, it, expect } from '../helpers/test.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LayoutFields, LayoutList } from '../../src/layout-format.js';
import { backfillDefaultViews, renderShowLayout, renderListLayout, writeDefaultLayout } from '../../src/cli/commands/default-view.js';

const fields = [
  { name: 'id', type: 'string', primary: true, label: 'ID' },
  { name: 'name', type: 'string', label: 'Name', required: true },
  { name: 'status', type: 'enum', label: 'Status', options: ['open', 'won'] },
  { name: 'owner_id', type: 'relation', label: 'Owner', target: 'user' },
  { name: 'lines', type: 'details', label: 'Lines', target: 'order_line' },
  { name: 'tags', type: 'multiRelation', label: 'Tags', target: 'tag' },
];

describe('default-view — renderShowLayout', () => {
  it('flat fields go into composite fields (nested 2-column grid, evenly split), skipping details/multiRelation', () => {
    const layout = renderShowLayout('order', fields);
    const fieldsNode = layout.viewports.desktop!.layout[0]! as LayoutFields;
    expect(fieldsNode.type).toBe('fields');
    expect('columns' in fieldsNode).toBe(false);
    // composite: children hold a single 2-column grid
    const grid = fieldsNode.children[0] as {
      type: string;
      columns: Array<{ children: Array<{ ui_id: string; type: string; object: string; field: string }> }>;
    };
    expect(grid.type).toBe('grid');
    expect(grid.columns).toHaveLength(2);
    const names = grid.columns.flatMap((c) => c.children.map((child) => child.ui_id));
    expect(names).toEqual(['id', 'status', 'name', 'owner_id']); // lines/tags skipped; column-major
    // round-robin distribution across the two columns
    expect(grid.columns[0]!.children.map((c) => c.ui_id)).toEqual(['id', 'status']);
    expect(grid.columns[1]!.children.map((c) => c.ui_id)).toEqual(['name', 'owner_id']);
    expect(grid.columns[0]!.children[0]).toMatchObject({ type: 'field', object: 'order', field: 'id' });
  });
});

describe('default-view — renderListLayout', () => {
  it('list node carries all listable flat field columns', () => {
    const layout = renderListLayout('order', fields);
    const list = layout.viewports.desktop!.layout[0]! as LayoutList;
    expect(list.type).toBe('list');
    expect(list.object).toBe('order');
    expect(list.columns).toEqual(['id', 'name', 'status', 'owner_id']);
  });
});

describe('default-view — writeDefaultLayout / backfillDefaultViews', () => {
  it('writes both show+list layouts, existing ones not overwritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-dv-'));
    try {
      const first = await writeDefaultLayout(root, 'order', fields);
      expect(first.written).toBe(true);
      expect(first.paths).toEqual([
        join('pages', 'order', 'show.layout.json'),
        join('pages', 'order', 'list.layout.json'),
      ]);
      const parsed = JSON.parse(await readFile(join(root, first.paths[0]!), 'utf8'));
      expect(parsed.viewports.desktop.layout[0].type).toBe('fields');
      const list = JSON.parse(await readFile(join(root, first.paths[1]!), 'utf8'));
      expect(list.viewports.desktop.layout[0].type).toBe('list');

      const second = await writeDefaultLayout(root, 'order', fields);
      expect(second.written).toBe(false);

      const written = await backfillDefaultViews(root, [
        { name: 'order', fields },
        { name: 'user', fields: [{ name: 'id', type: 'string' }] },
      ]);
      expect(written).toHaveLength(2); // only user is new (show + list)
      expect(written[0]).toContain(join('pages', 'user', 'show.layout.json'));
      expect(written[1]).toContain(join('pages', 'user', 'list.layout.json'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

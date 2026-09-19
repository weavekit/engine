import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry, SchemaError } from '../../src/core/index.js';
import {
  LAYOUT_PROFILES,
  PAGE_KINDS,
  layoutPagePath,
  layoutProfileFor,
  parseLayoutPagePath,
  validateLayoutProfile,
} from '../../src/layout-format.js';
import { readLayoutSource, readSource, writeLayoutSource } from '../../src/runtime/git/index.js';
import { describe, expect, it } from '../helpers/test.js';

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (_error, stdout) => resolve({ stdout }));
  });
}

function registry(): ObjectRegistry {
  const value = new ObjectRegistry();
  value.register({
    name: 'tickets',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'title', type: 'string' },
      { name: 'owner_id', type: 'relation', target: 'user' },
    ],
  });
  value.register({ name: 'user', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'name', type: 'string' }] });
  value.buildGraph();
  return value;
}

const objects = new Set(['tickets', 'user']);
const listable = (object: string): readonly string[] | undefined =>
  ({ tickets: ['id', 'title', 'owner_id'], user: ['id', 'name'] })[object];

function issues(layout: unknown, profile: typeof LAYOUT_PROFILES[keyof typeof LAYOUT_PROFILES]) {
  return validateLayoutProfile(layout as never, profile, { objects, listableFields: listable });
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wk-layout-src-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(join(root, 'pages', 'tickets'), { recursive: true });
    await writeFile(join(root, 'pages', 'tickets', 'show.layout.json'), '{"viewports":{"desktop":{"mode":"vertical","layout":[]}}}\n');
    await git(root, ['add', 'pages']);
    await git(root, ['commit', '-m', 'initial']);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('layout addressing', () => {
  it('round-trips layoutPagePath / parseLayoutPagePath', () => {
    const cases = [
      { addr: { kind: 'shell' } as const, path: 'app.layout' },
      { addr: { kind: 'custom', id: 'supplier-select' } as const, path: 'supplier-select/layout' },
      { addr: { kind: 'object', id: 'tickets', view: 'show' } as const, path: 'tickets/show.layout' },
      { addr: { kind: 'object', id: 'tickets', view: 'list' } as const, path: 'tickets/list.layout' },
      { addr: { kind: 'page-face', page: 'dash', object: 'lead', face: 'show' } as const, path: 'dash/objects/lead/show.layout' },
      { addr: { kind: 'page-face', page: 'dash', object: 'lead', face: 'list' } as const, path: 'dash/objects/lead/list.layout' },
    ];
    for (const c of cases) {
      expect(layoutPagePath(c.addr)).toBe(c.path);
      expect(parseLayoutPagePath(c.path)).toEqual(c.addr);
    }
    expect(parseLayoutPagePath('tickets')).toBeUndefined();
    expect(parseLayoutPagePath('app.layout')).toEqual({ kind: 'shell' });
    expect(parseLayoutPagePath('tickets/foo.layout')).toBeUndefined();
    // legacy flat custom form is rejected (forced migration to directories)
    expect(parseLayoutPagePath('supplier-select.layout')).toBeUndefined();
    expect(parseLayoutPagePath('app/layout')).toBeUndefined();
    // page-face needs an object and a face
    expect(parseLayoutPagePath('dash/objects/lead/show.layout')).toBeDefined();
    expect(parseLayoutPagePath('app/objects/lead/show.layout')).toBeUndefined();
  });

  it('maps kind + view onto the validation profile', () => {
    expect(layoutProfileFor(PAGE_KINDS.SHELL)).toBe(LAYOUT_PROFILES.SHELL);
    expect(layoutProfileFor(PAGE_KINDS.CUSTOM)).toBe(LAYOUT_PROFILES.CUSTOM);
    expect(layoutProfileFor(PAGE_KINDS.OBJECT, 'list')).toBe(LAYOUT_PROFILES.OBJECT_LIST);
    expect(layoutProfileFor(PAGE_KINDS.OBJECT, 'show')).toBe(LAYOUT_PROFILES.OBJECT_SHOW);
  });
});

describe('layout profile validation', () => {
  it('enforces the shell node set', () => {
    const good = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            { ui_id: 'nav', type: 'sidebar', groups: [] },
            { ui_id: 'content', type: 'outlet', name: 'content' },
            { ui_id: 'dlg', type: 'dialog', title: 'D', children: [] },
          ],
        },
      },
    };
    expect(issues(good, LAYOUT_PROFILES.SHELL)).toHaveLength(0);
    const bad = {
      viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'f', type: 'field', object: 'tickets', field: 'title' }] } },
    };
    const found = issues(bad, LAYOUT_PROFILES.SHELL);
    expect(found.some((i) => i.key === 'layout.node.notAllowed')).toBe(true);
    expect(found.some((i) => i.key === 'layout.shell.outletMissing')).toBe(true);
  });

  it('distinguishes list (first-class) from subtable (detail child)', () => {
    const inList = { viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'l', type: 'list', object: 'tickets' }] } } };
    expect(issues(inList, LAYOUT_PROFILES.OBJECT_LIST)).toHaveLength(0);
    // subtable is not allowed on a first-class list page
    const sub = { viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 's', type: 'subtable', object: 'user' }] } } };
    expect(issues(sub, LAYOUT_PROFILES.OBJECT_LIST).some((i) => i.key === 'layout.node.notAllowed')).toBe(true);
    // list is not allowed on the show/detail layout
    const showList = { viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'l', type: 'list', object: 'tickets' }] } } };
    expect(issues(showList, LAYOUT_PROFILES.OBJECT_SHOW).some((i) => i.key === 'layout.node.notAllowed')).toBe(true);
  });

  it('validates columns and object bindings for list/subtable', () => {
    const badCol = {
      viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'l', type: 'list', object: 'tickets', columns: ['nope'] }] } },
    };
    expect(issues(badCol, LAYOUT_PROFILES.CUSTOM).some((i) => i.key === 'layout.columns.invalid')).toBe(true);
    const badObj = {
      viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'l', type: 'list', object: 'ghost' }] } },
    };
    expect(issues(badObj, LAYOUT_PROFILES.CUSTOM).some((i) => i.key === 'layout.object.unknown')).toBe(true);
  });

  it('treats object-list as a single-list page: exactly one list, no other/nested blocks', () => {
    // a single list is valid
    const one = { viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'l', type: 'list', object: 'tickets' }] } } };
    expect(issues(one, LAYOUT_PROFILES.OBJECT_LIST)).toEqual([]);
    // two lists → singleList issue
    const two = { viewports: { desktop: { mode: 'vertical', layout: [
      { ui_id: 'a', type: 'list', object: 'tickets' },
      { ui_id: 'b', type: 'list', object: 'user' },
    ] } } };
    expect(issues(two, LAYOUT_PROFILES.OBJECT_LIST).some((i) => i.key === 'layout.objectList.singleList')).toBe(true);
    // a sibling block is not allowed at all (node type filter) — cannot co-exist with the list
    const withStat = { viewports: { desktop: { mode: 'vertical', layout: [
      { ui_id: 's', type: 'statcard', label: 'x', value: 1 },
      { ui_id: 'l', type: 'list', object: 'tickets' },
    ] } } };
    const statIssues = issues(withStat, LAYOUT_PROFILES.OBJECT_LIST);
    expect(statIssues.some((i) => i.key === 'layout.node.notAllowed')).toBe(true);
    expect(statIssues.some((i) => i.key === 'layout.objectList.singleList')).toBe(true);
  });

  it('keeps multi-block layouts on custom pages (list co-exists with other blocks)', () => {
    const multi = { viewports: { desktop: { mode: 'vertical', layout: [
      { ui_id: 's', type: 'statcard', label: 'x', value: 1 },
      { ui_id: 'l', type: 'list', object: 'tickets' },
    ] } } };
    expect(issues(multi, LAYOUT_PROFILES.CUSTOM)).toHaveLength(0);
  });

  it('rejects duplicate ui_id within a viewport and sidebar target conflicts', () => {
    const dup = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            { ui_id: 'x', type: 'section', label: 'A', children: [{ ui_id: 'f', type: 'field', object: 'tickets', field: 'title' }] },
            { ui_id: 'x', type: 'section', label: 'B', children: [] },
          ],
        },
      },
    };
    expect(issues(dup, LAYOUT_PROFILES.OBJECT_SHOW).some((i) => i.key === 'layout.uiId.duplicate')).toBe(true);

    const conflict = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            {
              ui_id: 'nav',
              type: 'sidebar',
              groups: [{ items: [{ label: 'Both', page: { kind: 'custom', id: 'x' }, href: '/x' }] }],
            },
            { ui_id: 'content', type: 'outlet', name: 'content' },
          ],
        },
      },
    };
    expect(issues(conflict, LAYOUT_PROFILES.SHELL).some((i) => i.key === 'layout.sidebar.target.conflict')).toBe(true);
  });

  it('accepts an optional icon name on sidebar items', () => {
    const withIcon = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            {
              ui_id: 'nav',
              type: 'sidebar',
              groups: [{ items: [{ label: 'Dash', icon: 'settings', page: { kind: 'custom', id: 'dash' } }] }],
            },
            { ui_id: 'content', type: 'outlet', name: 'content' },
          ],
        },
      },
    };
    expect(issues(withIcon, LAYOUT_PROFILES.SHELL)).toEqual([]);
  });

  it('validates dialog children against the content profile', () => {
    const dialogWithField = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            { ui_id: 'nav', type: 'sidebar', groups: [] },
            { ui_id: 'content', type: 'outlet', name: 'content' },
            { ui_id: 'dlg', type: 'dialog', title: 'D', children: [
              { ui_id: 'fs', type: 'fields', label: 'Main', children: [{ ui_id: 'g', type: 'grid', columns: [{ ui_id: 'gc', type: 'column', children: [{ ui_id: 'f', type: 'field', object: 'tickets', field: 'title' }] }] }] },
            ] },
          ],
        },
      },
    };
    expect(issues(dialogWithField, LAYOUT_PROFILES.SHELL)).toHaveLength(0);
    const dialogWithSidebar = {
      viewports: {
        desktop: {
          mode: 'vertical',
          layout: [
            { ui_id: 'dlg', type: 'dialog', children: [{ ui_id: 's', type: 'sidebar', groups: [] }] },
          ],
        },
      },
    };
    expect(issues(dialogWithSidebar, LAYOUT_PROFILES.CUSTOM).some((i) => i.key === 'layout.node.notAllowed')).toBe(true);
  });

  it('enforces the fields-container rule for field entries', () => {
    const bareFieldInSection = {
      viewports: { desktop: { mode: 'vertical', layout: [
        { ui_id: 's', type: 'section', label: 'S', children: [{ ui_id: 'f1', type: 'field', object: 'tickets', field: 'title' }] },
      ] } },
    };
    const sectionIssues = issues(bareFieldInSection, LAYOUT_PROFILES.OBJECT_SHOW);
    expect(sectionIssues.some((i) => i.key === 'layout.field.onlyInFields')).toBe(true);

    const goodFields = {
      viewports: { desktop: { mode: 'vertical', layout: [
        { ui_id: 's', type: 'section', label: 'S', children: [
          { ui_id: 'fs', type: 'fields', label: 'Main', children: [{ ui_id: 'g', type: 'grid', columns: [{ ui_id: 'gc', type: 'column', children: [{ ui_id: 'f2', type: 'field', object: 'tickets', field: 'title' }] }] }] },
        ] },
      ] } },
    };
    expect(issues(goodFields, LAYOUT_PROFILES.OBJECT_SHOW)).toEqual([]);

    // non-grid children inside `fields` are rejected (composite: only grids)
    const nonFieldInFields = {
      viewports: { desktop: { mode: 'vertical', layout: [
        { ui_id: 'fs', type: 'fields', children: [{ ui_id: 's', type: 'section', label: 'X', children: [] }] },
      ] } },
    };
    const wrongChild = issues(nonFieldInFields, LAYOUT_PROFILES.OBJECT_SHOW);
    expect(wrongChild.some((i) => i.key === 'layout.fields.childInvalid')).toBe(true);
  });

  it('validates grid columns (>=1, per-column ui_id + children, nested fixes)', () => {
    const goodGrid = {
      viewports: { desktop: { mode: 'vertical', layout: [
        { ui_id: 'g', type: 'grid', gap: 16, rowGap: 12, columns: [
          { ui_id: 'gc0', type: 'column', children: [{ ui_id: 'b0', type: 'filterbar', label: 'x' }] },
          { ui_id: 'gc1', type: 'column', children: [] },
        ] },
      ] } },
    };
    expect(issues(goodGrid, LAYOUT_PROFILES.OBJECT_SHOW)).toEqual([]);

    const emptyColumns = {
      viewports: { desktop: { mode: 'vertical', layout: [{ ui_id: 'g', type: 'grid', columns: [] }] } },
    };
    expect(issues(emptyColumns, LAYOUT_PROFILES.OBJECT_SHOW).some((i) => i.key === 'layout.children.invalid')).toBe(true);

    const missingColumnUiId = {
      viewports: { desktop: { mode: 'vertical', layout: [
        { ui_id: 'g', type: 'grid', columns: [{ type: 'column', children: [] }] },
      ] } },
    };
    expect(issues(missingColumnUiId, LAYOUT_PROFILES.OBJECT_SHOW).some((i) => i.key === 'layout.column.uiIdMissing')).toBe(true);
  });
});

describe('layout source store', () => {
  it('writes and reads a layout source (path-mirrored, single commit)', async () => {
    await withRepo(async (root) => {
      const source = '{"viewports":{"desktop":{"mode":"vertical","layout":[{"ui_id":"list","type":"list","object":"tickets","columns":["id","title"]}]}}}\n';
      const result = await writeLayoutSource({
        projectDir: root,
        addr: { kind: 'object', id: 'tickets', view: 'list' },
        source,
        registry: registry(),
      });
      expect(result.committed).toBe(true);
      expect(result.version).toMatch(/^[0-9a-f]{64}$/);
      const doc = await readLayoutSource(root, { kind: 'object', id: 'tickets', view: 'list' });
      expect(doc?.source).toBe(source);
      expect((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout.trim()).toBe('pages/tickets/list.layout.json');
    });
  });

  it('rejects a stale expectVersion with 409 and leaves the file untouched', async () => {
    await withRepo(async (root) => {
      let thrown: unknown;
      try {
        await writeLayoutSource({
          projectDir: root,
          addr: { kind: 'object', id: 'tickets', view: 'show' },
          source: '{"viewports":{}}',
          expectVersion: '0'.repeat(64),
          registry: registry(),
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('source.versionMismatch');
      expect(await readFile(join(root, 'pages', 'tickets', 'show.layout.json'), 'utf8')).toContain('"layout":[]');
    });
  });

  it('rejects an invalid layout before writing', async () => {
    await withRepo(async (root) => {
      let thrown: unknown;
      try {
        await writeLayoutSource({
          projectDir: root,
          addr: { kind: 'custom', id: 'dash' },
          source: '{"viewports":{"desktop":{"mode":"vertical","layout":[{"ui_id":"f","type":"field","object":"tickets","field":"title"}]}}}',
          registry: registry(),
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('layout.node.notAllowed');
      expect(await readSource(root, 'pages/dash/layout.json')).toBeNull();
    });
  });
});

import { describe, it, expect } from '../helpers/test.js';
import type { ObjectDescriptor } from '../../src/index.js';
import {
  getViewportLayout,
  resolveFieldEntry,
  VIEWPORTS,
  type LayoutFile,
} from '../../src/layout-format.js';

const descriptor: ObjectDescriptor = {
  name: 'lead',
  labels: { en: 'Lead' },
  fields: [
    { name: 'id', type: 'string', primary: true, labels: { en: 'ID' } },
    { name: 'name', type: 'string', labels: { en: 'Name' } },
    // `secret` is absent from fields — RBAC `fields.exclude` are stripped
    // server-side, so the descriptor a frontend sees never lists them
  ],
  relations: [],
  permissions: { read: 'all', create: true, update: null, delete: true, excludedFields: ['secret'], createFields: null },
};

const descriptors = new Map([[descriptor.name, descriptor]]);
const descriptorOf = (name: string) => descriptors.get(name);

describe('layout-format — getViewportLayout', () => {
  it('selects specified viewport, defaults to desktop', () => {
    const layout: LayoutFile = {
      viewports: {
        desktop: { mode: 'vertical', layout: [] },
        mobile: { mode: 'vertical', layout: [] },
      },
    };
    expect(getViewportLayout(layout, VIEWPORTS.MOBILE)).toBe(layout.viewports.mobile);
    expect(getViewportLayout(layout, VIEWPORTS.DESKTOP)).toBe(layout.viewports.desktop);
    expect(getViewportLayout(layout, 'mobile')).toBe(layout.viewports.mobile);
  });

  it('no mobile viewport → fallback to desktop; no layout/empty viewports → undefined', () => {
    const desktopOnly: LayoutFile = { viewports: { desktop: { mode: 'vertical', layout: [] } } };
    expect(getViewportLayout(desktopOnly, VIEWPORTS.MOBILE)).toBe(desktopOnly.viewports.desktop);
    expect(getViewportLayout(undefined, VIEWPORTS.DESKTOP)).toBeUndefined();
    expect(getViewportLayout({ viewports: {} }, VIEWPORTS.DESKTOP)).toBeUndefined();
  });
});

describe('layout-format — resolveFieldEntry', () => {
  it('resolves to real field via object+field; unknown/stripped field → undefined', () => {
    const field = resolveFieldEntry({ object: 'lead', field: 'name' }, descriptorOf);
    expect(field?.name).toBe('name');
    expect(resolveFieldEntry({ object: 'ghost', field: 'name' }, descriptorOf)).toBeUndefined();
    expect(resolveFieldEntry({ object: 'lead', field: 'ghost' }, descriptorOf)).toBeUndefined();
    // RBAC fields.exclude stripped server-side → descriptor lacks this field
    expect(resolveFieldEntry({ object: 'lead', field: 'secret' }, descriptorOf)).toBeUndefined();
  });

  it('object disambiguates same-named child-table fields', () => {
    const a: ObjectDescriptor = { ...descriptor, name: 'line_items', fields: [{ name: 'qty', type: 'integer', labels: { en: 'Qty A' } }] };
    const b: ObjectDescriptor = { ...descriptor, name: 'invoice_items', fields: [{ name: 'qty', type: 'integer', labels: { en: 'Qty B' } }] };
    const map = new Map([
      [a.name, a],
      [b.name, b],
    ]);
    expect(resolveFieldEntry({ object: 'line_items', field: 'qty' }, (n) => map.get(n))?.labels?.en).toBe('Qty A');
    expect(resolveFieldEntry({ object: 'invoice_items', field: 'qty' }, (n) => map.get(n))?.labels?.en).toBe('Qty B');
  });
});

import type { MetadataField, ObjectDescriptor } from './core/object/describe.js';
import type { MessageKey } from './core/i18n/en.js';

/**
 * Page layout format (hybrid: app-level pages live flat as `pages/<id>.layout.json`
 * — e.g. `pages/app.layout.json` — while object pages live in per-object dirs
 * `pages/<object>/<view>.layout.json` mirroring `objects/<name>/`) — engine-owned
 * single source (D11/D13/D15, SU-4b/SU-4c, SU-7c). Pure types + pure functions,
 * zero runtime imports (browser-safe via `@weave-kit/engine/layout` subpath —
 * consumers like `@weave-kit/ui` re-export these). Field entries are
 * reference-only: `{ui_id, object, field}` point at schema fields; every
 * attribute comes from `schema.json`. Naming: content blocks (field/tabs/
 * accordion/grid/section/subtable/list/blocks) vs shell blocks (sidebar/outlet/
 * dialog). Object binding happens only via `LayoutField`/`LayoutSubtable`/
 * `LayoutList` — generic blocks never bind an object.
 *
 * **Hard rule**: this file must stay import-free at runtime — only `import
 * type` (erased at compile time). Guarded by `tests/unit/values-browser-safe.test.ts`.
 */

export const VIEWPORTS = {
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
} as const;
export type Viewport = (typeof VIEWPORTS)[keyof typeof VIEWPORTS];

/** page classes — drive addressing (path shape), validation profile and lifecycle rules */
export const PAGE_KINDS = {
  SHELL: 'shell',
  OBJECT: 'object',
  CUSTOM: 'custom',
} as const;
export type PageKind = (typeof PAGE_KINDS)[keyof typeof PAGE_KINDS];

/** object page layout variants — mirror the physical layout files (`show`/`list`) */
export const OBJECT_LAYOUT_VIEWS = {
  SHOW: 'show',
  LIST: 'list',
} as const;
export type ObjectLayoutView = (typeof OBJECT_LAYOUT_VIEWS)[keyof typeof OBJECT_LAYOUT_VIEWS];

/**
 * Stable reference to an internal page — the host resolves it to a runtime URL
 * (never a handwritten path). Sidebar items and other references hold a
 * `PageRef` instead of a URL so custom-page renames stay atomic.
 */
export interface PageRef {
  kind: Exclude<PageKind, 'shell'>;
  id: string;
}

/** a field entry — resolved to a schema field via `object` + `field` (ui_id disambiguation) */
export interface LayoutField {
  ui_id: string;
  type: 'field';
  object: string;
  field: string;
  /** display label — required; defaults to the referenced `field` name when authored */
  label: string;
}

export interface LayoutTab {
  ui_id: string;
  label: string;
  columns?: number;
  /** a tab is a general container — any blocks (including `fields` containers) */
  children: LayoutNode[];
}

export interface LayoutTabs {
  ui_id: string;
  type: 'tabs';
  tabs: LayoutTab[];
}

export interface LayoutAccordion {
  ui_id: string;
  type: 'accordion';
  label?: string;
  children: LayoutNode[];
}

export interface LayoutGridColumn {
  ui_id: string;
  type: 'column';
  /** controls stacked vertically inside this column */
  children: LayoutNode[];
}

export interface LayoutGrid {
  ui_id: string;
  type: 'grid';
  /** one vertical stack (zone) per column — count defines the number of columns */
  columns: LayoutGridColumn[];
  /** horizontal gap between columns (px) */
  gap?: number;
  /** vertical gap between stacked controls inside a column (px) */
  rowGap?: number;
}

export interface LayoutSection {
  ui_id: string;
  type: 'section';
  label?: string;
  columns?: number;
  children: LayoutNode[];
}

/**
 * Composite field container — the ONLY place `field` entries may be added
 * (strict rule). It is a composite block: `children` holds one or more `grid`
 * blocks, and fields live inside those grids' columns (`fields > grid > column
 * > field`). The legacy flat `columns` attribute is removed — column layout is
 * owned by the inner `grid`.
 */
export interface LayoutFields {
  ui_id: string;
  type: 'fields';
  label?: string;
  children: LayoutNode[];
}

/** child-object list bound to the parent record (details) — read-only in v1 */
export interface LayoutSubtable {
  ui_id: string;
  type: 'subtable';
  object: string;
  columns?: string[];
}

/**
 * First-class object list (collection page / custom-page table) — distinct from
 * `subtable` (detail-page child table bound to a parent record). Runs the
 * `list.client.js` lifecycle (own query/pagination/filter/sort/row actions).
 */
export interface LayoutList {
  ui_id: string;
  type: 'list';
  object: string;
  columns?: string[];
  pageSize?: number;
  /** default sort applied to this list instance (NocoBase "sorting rules" minimal form) */
  defaultSort?: { field: string; dir: 'asc' | 'desc' };
}

/**
 * display block (governance + CRUD detail share these). Generic blocks never
 * bind an object — object binding happens via `LayoutField`/`LayoutSubtable`/
 * `LayoutList`. A runtime `object` key is rejected by the profile validator.
 */
export interface LayoutBlock {
  ui_id: string;
  type: 'filterbar' | 'statcard' | 'toolbar' | 'detail-panel' | 'timeline' | 'diffview';
  label?: string;
  /** block-specific props (open) */
  [key: string]: unknown;
}

/**
 * Sidebar nav **data** as stored in layout.json — no active flags (that is a UI
 * render concern; `@weave-kit/ui`'s `NavItem` is a superset with optional
 * `icon`/`active`, so these items are directly assignable to it). `icon` is a
 * **name string** resolved to a component by the UI layer (the engine stays
 * headless — it never imports icon components).
 * Exactly one of `page`/`href` must be set (enforced by the profile validator).
 */
export interface SidebarItem {
  label: string;
  /** icon name (lucide-style), resolved to a component by `@weave-kit/ui` */
  icon?: string;
  /** built-in route / legacy config / external link */
  href?: string;
  /** internal page target (PageRef) */
  page?: PageRef;
  badge?: string;
  disabled?: boolean;
  children?: SidebarItem[];
}

export interface SidebarGroups {
  label?: string;
  items: SidebarItem[];
  /**
   * dynamic group kind — `objects` lists every registry object (read-only,
   * runtime-derived; `items` is ignored when set)
   */
  kind?: 'objects';
}

/** shell: app navigation (sidebar; TopNav deprecated — no `top` variant) */
export interface LayoutSidebar {
  ui_id: string;
  type: 'sidebar';
  groups: SidebarGroups[];
  /** brand wordmark shown instead of the default ("WeaveKit") when set */
  appName?: string;
  /** brand logo URL/data-URI (replaces the wordmark image) */
  logo?: string;
}

/** shell: content outlet — the current routed page renders here */
export interface LayoutOutlet {
  ui_id: string;
  type: 'outlet';
  name: string;
}

/**
 * Self-contained modal container (SU-7c v5): content is authored inline as
 * `children` — there is no page reference. The runtime opens the modal and
 * renders `children` inside (LayoutView). Replaces the legacy `{ref:{page}}`
 * "dialog opens another page" model (D15 override).
 */
export interface LayoutDialog {
  ui_id: string;
  type: 'dialog';
  title?: string;
  children: LayoutNode[];
}

export type LayoutNode =
  | LayoutField
  | LayoutTabs
  | LayoutAccordion
  | LayoutGrid
  | LayoutSection
  | LayoutFields
  | LayoutSubtable
  | LayoutList
  | LayoutBlock
  | LayoutSidebar
  | LayoutOutlet
  | LayoutDialog;

export interface ViewportLayout {
  mode: 'vertical' | 'horizontal';
  layout: LayoutNode[];
}

export interface LayoutFile {
  viewports: Partial<Record<Viewport, ViewportLayout>>;
}

/**
 * Pick the layout for the current viewport, falling back to `desktop` when the
 * requested viewport is absent (D11 decision 1b). `undefined` → render flat.
 */
export function getViewportLayout(
  layout: LayoutFile | undefined,
  viewport: Viewport,
): ViewportLayout | undefined {
  if (layout === undefined) return undefined;
  return layout.viewports[viewport] ?? layout.viewports.desktop;
}

/**
 * Resolve a field entry `{ object, field }` to the real schema field via the
 * object descriptor. Unknown/ignored fields (RBAC `fields.exclude` are already
 * stripped server-side) resolve to `undefined` → the entry is not rendered.
 * The `object` discriminates same-named fields across child objects (D13).
 */
export function resolveFieldEntry(
  entry: { object: string; field: string },
  descriptor: (object: string) => ObjectDescriptor | undefined,
): MetadataField | undefined {
  return descriptor(entry.object)?.fields.find((f) => f.name === entry.field);
}

/** validation profile — derived from PageKind (+ object view) */
export const LAYOUT_PROFILES = {
  SHELL: 'shell',
  OBJECT_SHOW: 'object-show',
  OBJECT_LIST: 'object-list',
  CUSTOM: 'custom',
} as const;
export type LayoutProfile = (typeof LAYOUT_PROFILES)[keyof typeof LAYOUT_PROFILES];

/** map a page kind (+ object view) onto the validation profile */
export function layoutProfileFor(kind: PageKind, view?: ObjectLayoutView): LayoutProfile {
  if (kind === PAGE_KINDS.SHELL) return LAYOUT_PROFILES.SHELL;
  if (kind === PAGE_KINDS.CUSTOM) return LAYOUT_PROFILES.CUSTOM;
  return view === OBJECT_LAYOUT_VIEWS.LIST ? LAYOUT_PROFILES.OBJECT_LIST : LAYOUT_PROFILES.OBJECT_SHOW;
}

/** allowed node types for a profile — single source the designer palette filter is checked against */
export function allowedNodeTypesForProfile(profile: LayoutProfile): ReadonlySet<string> {
  return profileNodeTypes(profile);
}

/** a validation finding — `key` is an i18n message key; `path` locates the node */
export interface LayoutIssue {
  key: MessageKey;
  path: string;
  params: Record<string, unknown>;
}

/**
 * Page source address — discriminated by kind; drives the path-mirrored layout
 * API (`/pages/<path>`, e.g. `app.layout` / `<id>/layout` /
 * `tickets/show.layout` / `tickets/list.layout`).
 */
export type LayoutAddress =
  | { kind: 'shell' }
  | { kind: 'custom'; id: string }
  | { kind: 'object'; id: string; view: ObjectLayoutView }
  | { kind: 'page-face'; page: string; object: string; face: string };

/** the `/pages/<path>` path segment mirroring the physical file under `pages/` */
export function layoutPagePath(addr: LayoutAddress): string {
  switch (addr.kind) {
    case PAGE_KINDS.SHELL:
      return 'app.layout';
    case PAGE_KINDS.CUSTOM:
      return `${addr.id}/layout`;
    case PAGE_KINDS.OBJECT:
      return `${addr.id}/${addr.view}.layout`;
    case 'page-face':
      return `${addr.page}/objects/${addr.object}/${addr.face}.layout`;
  }
}

/** parse a `/pages/<path>` segment back into an address; `undefined` when malformed.
 *  Custom pages live in directories (`<id>/layout`); the legacy flat
 *  `<id>.layout` form is rejected (see `weave pages:migrate`). Page-scoped
 *  object faces (`<page>/objects/<object>/<face>.layout`) are per-user faces. */
export function parseLayoutPagePath(path: string): LayoutAddress | undefined {
  if (path === 'app.layout') return { kind: PAGE_KINDS.SHELL };
  const pageFaceMatch = /^([^/]+)\/objects\/([^/]+)\/(.+)\.layout$/.exec(path);
  if (pageFaceMatch !== null) {
    const page = pageFaceMatch[1]!;
    const object = pageFaceMatch[2]!;
    const face = pageFaceMatch[3]!;
    if (page !== '' && page !== 'app' && object !== '' && face !== '') {
      return { kind: 'page-face', page, object, face };
    }
    return undefined;
  }
  const objectMatch = /^([^/]+)\/(show|list)\.layout$/.exec(path);
  if (objectMatch !== null) {
    return { kind: PAGE_KINDS.OBJECT, id: objectMatch[1]!, view: objectMatch[2] as ObjectLayoutView };
  }
  const customMatch = /^([^/]+)\/layout$/.exec(path);
  if (customMatch !== null) {
    const id = customMatch[1]!;
    if (id !== '' && id !== 'app') return { kind: PAGE_KINDS.CUSTOM, id };
  }
  return undefined;
}

export interface LayoutValidationOptions {
  /** object names present in the registry (validates field/subtable/list `object`) */
  objects?: ReadonlySet<string>;
  /** listable (flat) field names per object (validates `columns`) */
  listableFields?: (object: string) => readonly string[] | undefined;
}

/** internal sentinel profile for `dialog` content (page-like, no shell blocks) */
type DialogProfile = 'dialog';

const SHELL_NODE_TYPES = new Set<string>(['sidebar', 'outlet', 'dialog']);
const OBJECT_SHOW_NODE_TYPES = new Set<string>([
  'field',
  'fields',
  'tabs',
  'accordion',
  'grid',
  'section',
  'subtable',
  'dialog',
  'outlet',
  'filterbar',
  'statcard',
  'toolbar',
  'detail-panel',
  'timeline',
  'diffview',
]);
/**
 * Object collection page is a SPECIAL single-list page: its desktop layout is
 * exactly one `list` node and nothing else (no sibling/nested blocks, no
 * containers). This keeps the page a full-height table by construction, so the
 * `fill` full-height behavior is unambiguous — multi-list layouts belong to
 * `custom` pages, which keep the full `CUSTOM_NODE_TYPES`.
 */
const OBJECT_LIST_NODE_TYPES = new Set<string>(['list']);
const CUSTOM_NODE_TYPES = new Set<string>([
  'list',
  'fields',
  'tabs',
  'accordion',
  'grid',
  'section',
  'dialog',
  'outlet',
  'filterbar',
  'statcard',
  'toolbar',
  'detail-panel',
  'timeline',
  'diffview',
]);
const DIALOG_NODE_TYPES = new Set<string>([
  'field',
  'fields',
  'tabs',
  'accordion',
  'grid',
  'section',
  'subtable',
  'list',
  'dialog',
  'outlet',
  'filterbar',
  'statcard',
  'toolbar',
  'detail-panel',
  'timeline',
  'diffview',
]);

function profileNodeTypes(profile: LayoutProfile | DialogProfile): ReadonlySet<string> {
  switch (profile) {
    case LAYOUT_PROFILES.SHELL:
      return SHELL_NODE_TYPES;
    case LAYOUT_PROFILES.OBJECT_SHOW:
      return OBJECT_SHOW_NODE_TYPES;
    case LAYOUT_PROFILES.OBJECT_LIST:
      return OBJECT_LIST_NODE_TYPES;
    case LAYOUT_PROFILES.CUSTOM:
      return CUSTOM_NODE_TYPES;
    case 'dialog':
      return DIALOG_NODE_TYPES;
  }
}

function push(issues: LayoutIssue[], key: MessageKey, path: string, params: Record<string, unknown> = {}): void {
  issues.push({ key, path, params });
}

function validateNode(
  node: LayoutNode,
  profile: LayoutProfile | DialogProfile,
  path: string,
  options: LayoutValidationOptions,
  issues: LayoutIssue[],
  seen: Map<string, string>,
  parentInFields = false,
): void {
  if (typeof node !== 'object' || node === null) {
    push(issues, 'layout.node.invalid', path);
    return;
  }
  const type = (node as { type?: unknown }).type;
  if (typeof type !== 'string' || type === '') {
    push(issues, 'layout.node.typeMissing', path);
    return;
  }
  const allowed = profileNodeTypes(profile);
  if (!allowed.has(type)) {
    push(issues, 'layout.node.notAllowed', path, { type, profile });
    return;
  }

  const uiId = (node as { ui_id?: unknown }).ui_id;
  if (typeof uiId !== 'string' || uiId === '') {
    push(issues, 'layout.uiId.missing', path, { type });
  } else {
    const prior = seen.get(uiId);
    if (prior !== undefined) {
      push(issues, 'layout.uiId.duplicate', path, { ui_id: uiId, first: prior });
    } else {
      seen.set(uiId, path);
    }
  }

  switch (type) {
    case 'tabs': {
      const tabs = (node as LayoutTabs).tabs;
      if (!Array.isArray(tabs)) {
        push(issues, 'layout.children.invalid', path, { type });
        return;
      }
      tabs.forEach((tab, i) => {
        const tabPath = `${path}.tabs[${i}]`;
        if (typeof tab !== 'object' || tab === null) {
          push(issues, 'layout.children.invalid', tabPath, { type: 'tabs' });
          return;
        }
        if (typeof tab.label !== 'string' || tab.label === '') push(issues, 'layout.tab.labelMissing', tabPath, {});
        if (typeof tab.ui_id !== 'string' || tab.ui_id === '') push(issues, 'layout.tab.uiIdMissing', tabPath, {});
        (tab.children ?? []).forEach((child, j) =>
          validateNode(child, profile, `${tabPath}.children[${j}]`, options, issues, seen, parentInFields),
        );
      });
      return;
    }
    case 'fields': {
      const children = (node as LayoutFields).children;
      if (!Array.isArray(children) || children.length === 0) {
        push(issues, 'layout.children.invalid', path, { type: 'fields' });
        return;
      }
      // composite block: children are `grid` blocks (fields live in their
      // columns); `parentInFields=true` propagates so `field` entries are
      // accepted inside the grids' columns
      children.forEach((child, i) => {
        const childPath = `${path}.children[${i}]`;
        if ((child as { type?: unknown }).type !== 'grid') {
          push(issues, 'layout.fields.childInvalid', childPath, {});
          return;
        }
        validateNode(child, profile, childPath, options, issues, seen, true);
      });
      return;
    }
    case 'grid': {
      const columns = (node as LayoutGrid).columns;
      if (!Array.isArray(columns) || columns.length === 0) {
        push(issues, 'layout.children.invalid', path, { type: 'grid' });
        return;
      }
      columns.forEach((column, ci) => {
        const columnPath = `${path}.columns[${ci}]`;
        if (typeof column !== 'object' || column === null) {
          push(issues, 'layout.children.invalid', columnPath, { type: 'grid' });
          return;
        }
        if (typeof column.ui_id !== 'string' || column.ui_id === '') {
          push(issues, 'layout.column.uiIdMissing', columnPath, {});
        }
        if (!Array.isArray(column.children)) {
          push(issues, 'layout.children.invalid', `${columnPath}.children`, { type: 'grid' });
          return;
        }
        column.children.forEach((child, i) =>
          validateNode(child, profile, `${columnPath}.children[${i}]`, options, issues, seen, parentInFields),
        );
      });
      return;
    }
    case 'accordion':
    case 'section': {
      const children = (node as LayoutAccordion | LayoutSection).children;
      if (!Array.isArray(children)) {
        push(issues, 'layout.children.invalid', path, { type });
        return;
      }
      children.forEach((child, i) =>
        validateNode(child, profile, `${path}.children[${i}]`, options, issues, seen, parentInFields),
      );
      return;
    }
    case 'dialog': {
      const children = (node as LayoutDialog).children;
      if (!Array.isArray(children)) {
        push(issues, 'layout.children.invalid', path, { type: 'dialog' });
        return;
      }
      children.forEach((child, i) =>
        validateNode(child, 'dialog', `${path}.children[${i}]`, options, issues, seen, parentInFields),
      );
      return;
    }
    case 'sidebar': {
      const groups = (node as LayoutSidebar).groups;
      if (!Array.isArray(groups)) {
        push(issues, 'layout.children.invalid', path, { type: 'sidebar' });
        return;
      }
      groups.forEach((group, gi) => {
        if (group.kind === 'objects') return; // dynamic group — runtime-derived, read-only
        const items = group.items;
        if (!Array.isArray(items)) {
          push(issues, 'layout.children.invalid', `${path}.groups[${gi}].items`, {});
          return;
        }
        items.forEach((item, ii) => {
          const itemPath = `${path}.groups[${gi}].items[${ii}]`;
          const hasHref = typeof item.href === 'string' && item.href !== '';
          const hasPage = item.page !== undefined;
          if (hasHref === hasPage) {
            push(issues, 'layout.sidebar.target.conflict', itemPath, { label: item.label });
            return;
          }
          if (hasPage) {
            if (item.page!.kind !== PAGE_KINDS.CUSTOM && item.page!.kind !== PAGE_KINDS.OBJECT) {
              push(issues, 'layout.pageRef.invalid', itemPath, { id: item.page!.id });
            }
            if (item.page!.id === '') push(issues, 'layout.pageRef.invalid', itemPath, {});
          }
        });
      });
      return;
    }
    case 'outlet': {
      const name = (node as LayoutOutlet).name;
      if (typeof name !== 'string' || name === '') push(issues, 'layout.outlet.nameMissing', path, {});
      return;
    }
    case 'field': {
      const entry = node as LayoutField;
      if (!parentInFields) push(issues, 'layout.field.onlyInFields', path, {});
      if (options.objects !== undefined && !options.objects.has(entry.object)) {
        push(issues, 'layout.object.unknown', path, { object: entry.object });
      }
      if (typeof entry.field !== 'string' || entry.field === '') push(issues, 'layout.field.nameMissing', path, {});
      return;
    }
    case 'subtable':
    case 'list': {
      const entry = node as LayoutSubtable | LayoutList;
      if (options.objects !== undefined && !options.objects.has(entry.object)) {
        push(issues, 'layout.object.unknown', path, { object: entry.object });
      }
      if (entry.columns !== undefined) {
        if (!Array.isArray(entry.columns)) {
          push(issues, 'layout.columns.invalid', path, { type });
        } else {
          const fields = options.listableFields?.(entry.object);
          if (fields !== undefined) {
            for (const col of entry.columns) {
              if (!fields.includes(col)) push(issues, 'layout.columns.invalid', path, { type, field: col });
            }
          }
        }
      }
      if (type === 'list') {
        const ds = (node as LayoutList).defaultSort;
        if (ds !== undefined && (typeof ds.field !== 'string' || (ds.dir !== 'asc' && ds.dir !== 'desc'))) {
          push(issues, 'layout.list.defaultSort.invalid', path, {});
        }
      }
      return;
    }
    case 'filterbar':
    case 'statcard':
    case 'toolbar':
    case 'detail-panel':
    case 'timeline':
    case 'diffview': {
      if ('object' in (node as LayoutBlock)) push(issues, 'layout.block.objectForbidden', path, { type });
      return;
    }
    default:
      push(issues, 'layout.node.unknown', path, { type });
  }
}

/**
 * Profile-aware pure validation of a whole layout file (SU-7c): allowed node
 * types per profile, per-viewport `ui_id` uniqueness, container/dialog children,
 * object bindings, sidebar target conflict, shell outlet presence. Returns
 * findings — the REST layer maps them onto localized `SchemaError`s.
 */
export function validateLayoutProfile(
  layout: LayoutFile,
  profile: LayoutProfile,
  options: LayoutValidationOptions = {},
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  if (typeof layout !== 'object' || layout === null || typeof layout.viewports !== 'object' || layout.viewports === null) {
    push(issues, 'layout.file.invalid', '');
    return issues;
  }

  for (const [viewport, viewportLayout] of Object.entries(layout.viewports)) {
    if (viewport !== VIEWPORTS.DESKTOP && viewport !== VIEWPORTS.MOBILE) {
      push(issues, 'layout.viewport.unknown', `viewports.${viewport}`, { viewport });
      continue;
    }
    if (typeof viewportLayout !== 'object' || viewportLayout === null) {
      push(issues, 'layout.viewport.invalid', `viewports.${viewport}`, { viewport });
      continue;
    }
    if (viewportLayout.mode !== 'vertical' && viewportLayout.mode !== 'horizontal') {
      push(issues, 'layout.viewport.mode.invalid', `viewports.${viewport}`, { viewport });
    }
    if (!Array.isArray(viewportLayout.layout)) {
      push(issues, 'layout.children.invalid', `viewports.${viewport}.layout`, {});
      continue;
    }
    const seen = new Map<string, string>();
    viewportLayout.layout.forEach((node, i) =>
      validateNode(node, profile, `viewports.${viewport}.layout[${i}]`, options, issues, seen),
    );
    if (profile === LAYOUT_PROFILES.OBJECT_LIST) {
      // object-list is a special single-list page: exactly one top-level `list`
      // node (the node-type filter already rejects other block kinds; this
      // guards the count + nested placement). Any deviation is a hard issue.
      const lists = viewportLayout.layout.filter((n) => n.type === 'list');
      if (lists.length !== 1 || viewportLayout.layout.length !== 1) {
        push(issues, 'layout.objectList.singleList', `viewports.${viewport}`, { viewed: viewport, count: lists.length });
      }
    }
    if (profile === LAYOUT_PROFILES.SHELL && !viewportLayout.layout.some((n) => n.type === 'outlet')) {
      push(issues, 'layout.shell.outletMissing', `viewports.${viewport}`, { viewport });
    }
  }
  return issues;
}

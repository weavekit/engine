import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ObjectRegistry, SchemaError, type Locale } from '../../core/index.js';
import {
  OBJECT_LAYOUT_VIEWS,
  type LayoutFile,
  type ObjectLayoutView,
} from '../../layout-format.js';
import type { AutoCommitOptions } from './autoCommit.js';
import { validateLayoutCandidate } from './layoutSource.js';
import { readSource, sourceVersion, writeSourceAtomically } from './sourceFile.js';
import {
  deleteSourceDir,
  runSerialized,
  runSourceTransaction,
} from './sourceTransaction.js';
import { commitPaths } from './autoCommit.js';

/**
 * Page catalog + custom-page lifecycle. Pages are first-class layout
 * files; custom pages are menu pages living in **directories** (`pages/<id>/layout.json`
 * — the whole page model is directory-based: object pages in `pages/<object>/show|list.layout.json`,
 * custom pages in `pages/<id>/layout.json`, the shell stays flat `pages/app.layout.json`).
 * References to a custom page live in the shell sidebar (`SidebarItem.page` PageRefs) —
 * delete is blocked (409) while references exist; rename updates them atomically.
 */

export type PageSummary =
  | { kind: 'shell'; id: 'app'; path: string }
  | { kind: 'object'; id: string; view: ObjectLayoutView; path: string }
  | { kind: 'custom'; id: string; path: string };

export function emptyCustomLayout(): LayoutFile {
  return { viewports: { desktop: { mode: 'vertical', layout: [] } } };
}

const CUSTOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function assertCustomId(id: string, locale?: Locale): void {
  if (id === 'app' || !CUSTOM_ID_PATTERN.test(id)) {
    throw new SchemaError('http.param.invalid', { param: 'id' }, locale);
  }
}

function walkSidebarItems(layout: LayoutFile, visit: (item: { group?: string; item: { label: string; page?: { kind: string; id: string } } }) => void): void {
  for (const viewportLayout of Object.values(layout.viewports)) {
    if (viewportLayout === undefined) continue;
    for (const node of viewportLayout.layout) {
      if (node.type !== 'sidebar') continue;
      for (const group of node.groups) {
        for (const item of group.items) {
          visit({ group: group.label, item: { label: item.label, page: item.page } });
        }
      }
    }
  }
}

/** find sidebar references to a custom page (group label + item label) */
export function findCustomPageRefs(
  shellSource: string | undefined,
  id: string,
): Array<{ group?: string; item: string }> {
  if (shellSource === undefined) return [];
  try {
    const layout = JSON.parse(shellSource) as LayoutFile;
    const refs: Array<{ group?: string; item: string }> = [];
    walkSidebarItems(layout, ({ group, item }) => {
      if (item.page?.kind === 'custom' && item.page.id === id) refs.push({ group, item: item.label });
    });
    return refs;
  } catch {
    return [];
  }
}

function replaceCustomPageRefs(shellSource: string, id: string, newId: string): string {
  const layout = JSON.parse(shellSource) as LayoutFile;
  walkSidebarItems(layout, ({ item }) => {
    if (item.page?.kind === 'custom' && item.page.id === id) item.page.id = newId;
  });
  return `${JSON.stringify(layout, null, 2)}\n`;
}

/** list every page (shell + object show/list + custom) — stable sort by path */
export async function listPages(
  projectDir: string,
  registry: ObjectRegistry,
): Promise<PageSummary[]> {
  const result: PageSummary[] = [];
  if ((await readSource(projectDir, 'pages/app.layout.json')) !== null) {
    result.push({ kind: 'shell', id: 'app', path: 'app.layout' });
  }
  for (const def of registry.list()) {
    if ((await readSource(projectDir, `pages/${def.name}/show.layout.json`)) !== null) {
      result.push({ kind: 'object', id: def.name, view: OBJECT_LAYOUT_VIEWS.SHOW, path: `${def.name}/show.layout` });
    }
    if ((await readSource(projectDir, `pages/${def.name}/list.layout.json`)) !== null) {
      result.push({ kind: 'object', id: def.name, view: OBJECT_LAYOUT_VIEWS.LIST, path: `${def.name}/list.layout` });
    }
  }
  const pagesDir = join(projectDir, 'pages');
  const objectDirs = new Set(registry.list().map((o) => o.name));
  const customIds: string[] = [];
  try {
    for (const entry of await readdir(pagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // legacy flat `pages/<id>.layout.json` files are rejected
      const name = entry.name;
      if (name === 'app' || objectDirs.has(name)) continue; // object dirs win; 'app' is reserved (flat shell)
      if ((await readSource(projectDir, `pages/${name}/layout.json`)) !== null) customIds.push(name);
    }
  } catch {
    // no pages dir yet
  }
  customIds.sort();
  for (const id of customIds) {
    result.push({ kind: 'custom', id, path: `${id}/layout` });
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export interface CreateCustomPageOptions {
  projectDir: string;
  registry: ObjectRegistry;
  id: string;
  source?: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export async function createCustomPage(
  options: CreateCustomPageOptions,
): Promise<{ path: string; version: string }> {
  const { projectDir, registry, id, source, identity, locale } = options;
  assertCustomId(id, locale);
  if (registry.get(id) !== undefined) {
    // the page dir `pages/<id>/` would collide with the object's page dir
    throw new SchemaError('page.exists', { id }, locale);
  }
  const content =
    source ?? `${JSON.stringify(emptyCustomLayout(), null, 2)}\n`;
  if (source !== undefined) {
    validateLayoutCandidate({ addr: { kind: 'custom', id }, source, registry, locale });
  }
  const existing = await readSource(projectDir, `pages/${id}/layout.json`);
  if (existing !== null) {
    throw new SchemaError('page.exists', { id }, locale);
  }
  await runSourceTransaction({
    projectDir,
    files: [{ path: `pages/${id}/layout.json`, source: content }],
    identity,
    locale,
    message: `chore(pages): create ${id}`,
  });
  return { path: `${id}/layout`, version: sourceVersion(content) };
}

export interface DeleteCustomPageOptions {
  projectDir: string;
  id: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export async function deleteCustomPage(options: DeleteCustomPageOptions): Promise<{ deleted: boolean }> {
  const { projectDir, id, identity, locale } = options;
  assertCustomId(id, locale);
  const shell = await readSource(projectDir, 'pages/app.layout.json');
  const refs = findCustomPageRefs(shell?.source, id);
  if (refs.length > 0) {
    throw new SchemaError('page.ref.inUse', { id, count: refs.length, refs: JSON.stringify(refs) }, locale);
  }
  const result = await deleteSourceDir({
    projectDir,
    dir: `pages/${id}`,
    message: `chore(pages): delete ${id}`,
    identity,
    locale,
  });
  return { deleted: result.committed };
}

export interface RenameCustomPageOptions {
  projectDir: string;
  id: string;
  newId: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

/** atomically rename a custom page: move the page directory + update shell PageRefs in one commit */
export function renameCustomPage(options: RenameCustomPageOptions): Promise<{ path: string }> {
  const { projectDir, id, newId, identity, locale } = options;
  assertCustomId(id, locale);
  assertCustomId(newId, locale);
  return runSerialized(projectDir, async () => {
    const oldSource = await readSource(projectDir, `pages/${id}/layout.json`);
    if (oldSource === null) throw new SchemaError('http.notFound', {}, locale);
    if ((await readSource(projectDir, `pages/${newId}/layout.json`)) !== null) {
      throw new SchemaError('page.exists', { id: newId }, locale);
    }
    const shell = await readSource(projectDir, 'pages/app.layout.json');
    let shellSource: string | undefined;
    if (shell !== null) {
      shellSource = replaceCustomPageRefs(shell.source, id, newId);
    }
    const oldDir = join(projectDir, 'pages', id);
    const newDir = join(projectDir, 'pages', newId);
    const shellPath = 'pages/app.layout.json';
    const shellChanged = shellSource !== undefined && shell !== null && shellSource !== shell.source;

    await rm(newDir, { recursive: true, force: true });
    await rename(oldDir, newDir);
    if (shellChanged) await writeSourceAtomically(projectDir, shellPath, shellSource!);
    const paths = shellChanged ? [`pages/${id}`, `pages/${newId}`, shellPath] : [`pages/${id}`, `pages/${newId}`];

    try {
      await commitPaths({
        dir: projectDir,
        paths,
        message: `chore(pages): rename ${id} to ${newId}`,
        identity,
        locale,
      });
      return { path: `${newId}/layout` };
    } catch (error) {
      await rm(oldDir, { recursive: true, force: true });
      await rename(newDir, oldDir);
      if (shellChanged && shell !== null) {
        await writeSourceAtomically(projectDir, shellPath, shell.source);
      }
      throw error;
    }
  });
}

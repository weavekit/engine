import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Locale } from '../../core/index.js';
import type { AutoCommitOptions } from './autoCommit.js';
import { commitPath } from './autoCommit.js';
import { readSource, sourceVersion, writeSourceAtomically } from './sourceFile.js';
import { validateScriptSource } from './scriptSource.js';

/**
 * Page-scoped client scripts (per-user). Only **client** scripts live here
 * (`server.js` stays object-level in `objects/<X>/`). A page binding an object
 * carries its own face scripts under `pages/<page>/objects/<object>/<kind>.client.js`
 * (show.client / list.client); the runtime falls back to the object's canonical
 * scripts at `pages/<object>/<kind>.client.js`. There are NO page-level or
 * block-level script files anymore.
 */
export const PAGE_SCRIPT_KINDS = {
  SHOW_CLIENT: 'show.client',
  LIST_CLIENT: 'list.client',
} as const;
export type PageScriptKind = (typeof PAGE_SCRIPT_KINDS)[keyof typeof PAGE_SCRIPT_KINDS];

export function isPageScriptKind(value: string): value is PageScriptKind {
  return value === PAGE_SCRIPT_KINDS.SHOW_CLIENT || value === PAGE_SCRIPT_KINDS.LIST_CLIENT;
}

export interface PageScriptDocument {
  source: string;
  version: string;
}

/** `pages/<page>/objects/<object>/<kind>.client.js` (page × object face script) */
export function pageFaceScriptRelPath(page: string, object: string, kind: PageScriptKind): string {
  return `pages/${page}/objects/${object}/${kind}.js`;
}

export async function readPageScript(
  projectDir: string,
  relPath: string,
): Promise<PageScriptDocument | null> {
  return readSource(projectDir, relPath);
}

export interface WritePageScriptOptions {
  projectDir: string;
  relPath: string;
  source: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface WritePageScriptResult extends PageScriptDocument {
  committed: boolean;
}

export async function writePageScript(options: WritePageScriptOptions): Promise<WritePageScriptResult> {
  const { projectDir, relPath, source, identity, locale } = options;
  await validateScriptSource(source, PAGE_SCRIPT_KINDS.SHOW_CLIENT, locale);
  const absolute = join(projectDir, relPath);
  const previous = await readSource(projectDir, relPath);
  const version = sourceVersion(source);
  if (previous?.version === version) return { source, version, committed: false };

  await mkdir(dirname(absolute), { recursive: true });
  await writeSourceAtomically(projectDir, relPath, source);
  try {
    const commit = await commitPath({
      dir: projectDir,
      path: relPath,
      message: `chore(pages): update script ${relPath}`,
      identity,
      locale,
    });
    return { source, version, committed: commit.committed };
  } catch (error) {
    if (previous === null) {
      await rm(absolute, { force: true });
    } else {
      await writeSourceAtomically(projectDir, relPath, previous.source);
    }
    throw error;
  }
}

export async function deletePageScript(
  projectDir: string,
  relPath: string,
  identity?: AutoCommitOptions['identity'],
  locale?: Locale,
): Promise<{ deleted: boolean }> {
  const baseline = await readSource(projectDir, relPath);
  if (baseline === null) return { deleted: false };
  await rm(join(projectDir, relPath), { force: true });
  try {
    const commit = await commitPath({
      dir: projectDir,
      path: relPath,
      message: `chore(pages): delete script ${relPath}`,
      identity,
      locale,
    });
    return { deleted: commit.committed };
  } catch (error) {
    await writeSourceAtomically(projectDir, relPath, baseline.source);
    throw error;
  }
}

/** parse a page-face script scope (`<page>/objects/<object>`) — the `/pages/<scope>/scripts/<kind>` form */
export function parsePageFaceScope(scope: string): { page: string; object: string } | undefined {
  const match = /^([^/]+)\/objects\/([^/]+)$/.exec(scope);
  if (match === null) return undefined;
  const page = match[1]!;
  const object = match[2]!;
  if (page === '' || page === 'app' || object === '') return undefined;
  return { page, object };
}

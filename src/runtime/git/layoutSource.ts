import {
  FIELD_TYPES,
  ObjectRegistry,
  SchemaError,
  type Locale,
} from '../../core/index.js';
import {
  LAYOUT_PROFILES,
  layoutPagePath,
  layoutProfileFor,
  validateLayoutProfile,
  type LayoutAddress,
  type LayoutFile,
  type LayoutIssue,
} from '../../layout-format.js';
import type { AutoCommitOptions } from './autoCommit.js';
import { readSource, sourceVersion } from './sourceFile.js';
import { runSourceTransaction } from './sourceTransaction.js';

/**
 * Layout source store: path-mirrored read/write of `pages/<path>.json`
 * with profile-aware validation. Addressing is driven by {@link LayoutAddress}
 * — the `/pages/<path>` shape mirrors the physical file (kind/view in the path).
 */

export interface LayoutSourceDocument {
  source: string;
  version: string;
}

export interface WriteLayoutSourceOptions {
  projectDir: string;
  addr: LayoutAddress;
  source: string;
  expectVersion?: string;
  force?: boolean;
  registry: ObjectRegistry;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface WriteLayoutSourceResult extends LayoutSourceDocument {
  committed: boolean;
}

/** working-tree path under the project for a layout address */
export function layoutPathOf(addr: LayoutAddress): string {
  return `pages/${layoutPagePath(addr)}.json`;
}

export async function readLayoutSource(
  projectDir: string,
  addr: LayoutAddress,
): Promise<LayoutSourceDocument | null> {
  return readSource(projectDir, layoutPathOf(addr));
}

/** throw the first layout validation issue as a localized SchemaError */
export function throwLayoutIssues(issues: LayoutIssue[], locale?: Locale): void {
  if (issues.length === 0) return;
  const first = issues[0]!;
  throw new SchemaError(first.key, { ...first.params, path: first.path }, locale);
}

/** listable (flat) field names per object — drives `columns` validation */
export function listableFieldsOf(
  registry: ObjectRegistry,
): (object: string) => readonly string[] | undefined {
  return (object) => {
    const def = registry.get(object);
    if (def === undefined) return undefined;
    return def.fields
      .filter((f) => f.type !== FIELD_TYPES.DETAILS && f.type !== FIELD_TYPES.MULTI_RELATION)
      .map((f) => f.name);
  };
}

/** validate a layout source for its address profile; throws the first issue */
export function validateLayoutCandidate(options: {
  addr: LayoutAddress;
  source: string;
  registry: ObjectRegistry;
  locale?: Locale;
}): void {
  const { addr, source, registry, locale } = options;
  let parsed: LayoutFile;
  try {
    parsed = JSON.parse(source) as LayoutFile;
  } catch {
    throw new SchemaError('http.param.invalid', { param: 'layout' }, locale);
  }
  const profile =
    addr.kind === 'page-face'
      ? addr.face === 'list'
        ? LAYOUT_PROFILES.OBJECT_LIST
        : addr.face === 'show'
          ? LAYOUT_PROFILES.OBJECT_SHOW
          : LAYOUT_PROFILES.CUSTOM
      : layoutProfileFor(addr.kind, addr.kind === 'object' ? addr.view : undefined);
  const objects = new Set(registry.list().map((o) => o.name));
  const issues = validateLayoutProfile(parsed, profile, {
    objects,
    listableFields: listableFieldsOf(registry),
  });
  throwLayoutIssues(issues, locale);
}

export async function writeLayoutSource(
  options: WriteLayoutSourceOptions,
): Promise<WriteLayoutSourceResult> {
  const { projectDir, addr, source, expectVersion, force, registry, identity, locale } = options;
  validateLayoutCandidate({ addr, source, registry, locale });
  const result = await runSourceTransaction({
    projectDir,
    files: [{ path: layoutPathOf(addr), source, expectVersion }],
    force,
    identity,
    locale,
    message: `chore(layout): update ${layoutPagePath(addr)}`,
  });
  return { source, version: sourceVersion(source), committed: result.committed };
}

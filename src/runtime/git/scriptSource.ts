import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SCRIPT_SOURCE_KINDS,
  SchemaError,
  invalidScriptHookSignatures,
  type Locale,
  type ObjectRegistry,
  type ScriptSourceKind,
} from '../../core/index.js';
import { commitPath, type AutoCommitOptions } from './autoCommit.js';
import { readSource, sourceVersion, writeSourceAtomically } from './sourceFile.js';
export interface ScriptSourceDocument {
  source: string;
  version: string;
}

export interface WriteScriptSourceOptions {
  projectDir: string;
  registry: ObjectRegistry;
  objectName: string;
  kind: ScriptSourceKind;
  source: string;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface WriteScriptSourceResult extends ScriptSourceDocument {
  committed: boolean;
}

/** canonical script file path. `server.js` stays object-level in `objects/<X>/`;
 *  client scripts live with the object's UI assets in `pages/<X>/<kind>.client.js`. */
function sourcePath(projectDir: string, registry: ObjectRegistry, objectName: string, kind: ScriptSourceKind): string {
  if (registry.get(objectName) === undefined) {
    throw new SchemaError('data.objectUnknown', { object: objectName });
  }
  if (!Object.values(SCRIPT_SOURCE_KINDS).includes(kind)) {
    throw new SchemaError('http.param.invalid', { param: 'kind' });
  }
  const rel =
    kind === SCRIPT_SOURCE_KINDS.SERVER
      ? `objects/${objectName}/server.js`
      : `pages/${objectName}/${kind}.js`;
  return join(projectDir, rel);
}

/** sha256 version of a script source (kept as the script-source API surface) */
export function scriptSourceVersion(source: string): string {
  return sourceVersion(source);
}

export async function validateScriptSource(source: string, kind: ScriptSourceKind, locale?: Locale): Promise<void> {
  try {
    const { transformSync } = await import('esbuild');
    transformSync(source, { loader: 'js', format: 'esm' });
  } catch (error) {
    throw new SchemaError('http.param.invalid', { param: 'source', detail: error instanceof Error ? error.message : String(error) }, locale);
  }
  if (kind === SCRIPT_SOURCE_KINDS.SERVER) {
    const invalid = invalidScriptHookSignatures(source);
    if (invalid.length > 0) {
      throw new SchemaError(
        'http.param.invalid',
        { param: 'source', detail: `hooks must declare no parameters: ${invalid.join(', ')}` },
        locale,
      );
    }
  }
}

/** canonical script relative path (see `sourcePath`) */
function scriptRelPath(objectName: string, kind: ScriptSourceKind): string {
  return kind === SCRIPT_SOURCE_KINDS.SERVER
    ? `objects/${objectName}/server.js`
    : `pages/${objectName}/${kind}.js`;
}

export async function readScriptSource(
  projectDir: string,
  registry: ObjectRegistry,
  objectName: string,
  kind: ScriptSourceKind,
): Promise<ScriptSourceDocument | null> {
  sourcePath(projectDir, registry, objectName, kind); // validates object/kind
  return readSource(projectDir, scriptRelPath(objectName, kind));
}

export async function writeScriptSource(options: WriteScriptSourceOptions): Promise<WriteScriptSourceResult> {
  const { projectDir, registry, objectName, kind, source, identity, locale } = options;
  const path = sourcePath(projectDir, registry, objectName, kind);
  const relPath = scriptRelPath(objectName, kind);
  await validateScriptSource(source, kind, locale);
  const previous = await readScriptSource(projectDir, registry, objectName, kind);
  const version = scriptSourceVersion(source);
  if (previous?.version === version) return { source, version, committed: false };

  await mkdir(dirname(path), { recursive: true });
  await writeSourceAtomically(projectDir, relPath, source);

  try {
    const commit = await commitPath({
      dir: projectDir,
      path: relPath,
      message: `chore(scripts): update ${objectName}/${kind}.js`,
      identity,
      locale,
    });
    return { source, version, committed: commit.committed };
  } catch (error) {
    if (previous === null) {
      await rm(path, { force: true });
    } else {
      await writeSourceAtomically(projectDir, relPath, previous.source);
    }
    throw error;
  }
}
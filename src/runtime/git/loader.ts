import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ObjectRegistry, SchemaError, parseSchema } from '../../core/index.js';
import type { Locale, ObjectDefinition } from '../../core/index.js';

export interface SchemaFile {
  /** absolute path to the schema.json file */
  path: string;
  /** object name, derived from the parent directory name */
  name: string;
  /** sha256 hex digest of the raw file content */
  contentHash: string;
  /** validated object definition */
  object: ObjectDefinition;
}

export interface LoadResult {
  registry: ObjectRegistry;
  files: SchemaFile[];
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Directory layout: one object per directory — `objects/<name>/schema.json`.
 * The parent directory name must equal the object name (`nameHint` check).
 * Any other file under the tree (future workflow.json/script.ts) is ignored.
 */
async function collectSchemaFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSchemaFiles(full, out);
    } else if (entry.isFile() && entry.name === 'schema.json') {
      out.push(full);
    }
  }
}

/** load and validate every `objects/<name>/schema.json` under a project root */
export async function loadSchemaDir(
  dir: string,
  options: { locale?: Locale; allowedFieldTypes?: readonly string[] } = {},
): Promise<LoadResult> {
  const objectsDir = join(dir, 'objects');
  let isDir = false;
  try {
    isDir = (await stat(objectsDir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new SchemaError('loader.dir.missing', { dir: objectsDir }, options.locale);
  }

  const paths: string[] = [];
  await collectSchemaFiles(objectsDir, paths);

  const registry = new ObjectRegistry();
  const files: SchemaFile[] = [];
  for (const path of paths.sort()) {
    const name = basename(dirname(path));
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new SchemaError('loader.file.read', { file: path }, options.locale);
    }
    const object = parseSchema(raw, { locale: options.locale, nameHint: name, allowedFieldTypes: options.allowedFieldTypes });
    registry.register(object, { locale: options.locale, allowedFieldTypes: options.allowedFieldTypes });
    files.push({ path, name, contentHash: sha256(raw), object });
  }
  return { registry, files };
}

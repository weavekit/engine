import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SchemaError } from '../../core/index.js';
import { buildEnumRegistry, validateEnumDefinition } from '../../core/index.js';
import type { EnumDefinition, EnumRegistry, Locale } from '../../core/index.js';

/**
 * Named-enum declaration loader (`<schemaDir>/enums/*.json`). Each file is a
 * JSON declaration whose `name` must equal the filename (mirrors the objects
 * convention: directory/file name is the identity). Declarations are
 * project-local and committed to Git, so schemas stay reproducible.
 *
 * A missing `enums/` directory is not an error (named enums are opt-in) — it
 * resolves to the empty registry, so nothing changes for existing projects.
 */

export interface LoadedEnum {
  /** absolute path of the declaration file */
  path: string;
  /** validated declaration */
  definition: EnumDefinition;
}

async function collectEnumFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) out.push(join(dir, entry.name));
  }
}

/** load + validate every `enums/<name>.json` (missing dir → empty list) */
export async function loadEnumsDir(dir: string, options: { locale?: Locale } = {}): Promise<LoadedEnum[]> {
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return [];

  const files: string[] = [];
  await collectEnumFiles(dir, files);

  const loaded: LoadedEnum[] = [];
  for (const file of files.sort()) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      throw new SchemaError('enum.invalid', { detail: `cannot read "${file}"` }, options.locale);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new SchemaError('enum.invalid', { detail: `"${file}" is not valid JSON` }, options.locale);
    }
    const definition = validateEnumDefinition(data, options.locale);
    const hint = basename(file, '.json');
    if (definition.name !== hint) {
      throw new SchemaError(
        'enum.invalid',
        { detail: `"${file}" declares name "${definition.name}" but the file is named "${hint}.json"` },
        options.locale,
      );
    }
    loaded.push({ path: file, definition });
  }
  return loaded;
}

/** resolve an effective enum registry from a directory and/or inline definitions */
export async function resolveEnumRegistry(
  options: { dir?: string; entries?: readonly EnumDefinition[]; locale?: Locale } = {},
): Promise<EnumRegistry> {
  const definitions: EnumDefinition[] = [];
  if (options.dir !== undefined) {
    const loaded = await loadEnumsDir(options.dir, { locale: options.locale });
    definitions.push(...loaded.map((l) => l.definition));
  }
  for (const entry of options.entries ?? []) definitions.push(entry);
  return buildEnumRegistry(definitions);
}

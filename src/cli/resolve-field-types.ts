import { resolve } from 'node:path';
import { resolveFieldTypeRegistry } from '../runtime/fieldtypes/index.js';
import type { FieldTypeRegistry } from '../core/index.js';
import type { LoadedConfig } from './load-config.js';

/**
 * Resolve the project's effective field-type registry (built-ins + the
 * project-local `config.fieldTypes` dir/entries). `fieldTypes.dir` is resolved
 * relative to `schemaDir` (mirrors `tools.toolsDir`).
 */
export async function resolveProjectFieldTypes(cwd: string, config: LoadedConfig): Promise<FieldTypeRegistry> {
  const schemaDir = config.schemaDir ?? cwd;
  const fieldTypes = config.fieldTypes;
  return resolveFieldTypeRegistry({
    dir: fieldTypes?.dir === undefined ? undefined : resolve(schemaDir, fieldTypes.dir),
    entries: fieldTypes?.entries,
    locale: config.locale,
  });
}

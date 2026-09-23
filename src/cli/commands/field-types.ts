import { basename, resolve } from 'node:path';
import { DEFAULT_FIELD_TYPE_REGISTRY } from '../../core/index.js';
import type { FieldTypeRegistration, FieldTypeRegistry } from '../../core/index.js';
import { loadFieldTypesDir, normalizeFieldTypeRegistration } from '../../runtime/fieldtypes/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { LoadedConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { FieldTypeCheckOptions, FieldTypeListOptions } from '../types/index.js';

interface RegisteredEntry {
  name: string;
  source: string;
  registration: FieldTypeRegistration;
}

/** load every registration (dir modules + inline config entries) with its source label */
async function collectRegistered(
  cwd: string,
  config: LoadedConfig,
): Promise<RegisteredEntry[]> {
  const schemaDir = config.schemaDir ?? cwd;
  const dir = config.fieldTypes?.dir === undefined ? undefined : resolve(schemaDir, config.fieldTypes.dir);
  const entries: RegisteredEntry[] = [];
  if (dir !== undefined) {
    const loaded = await loadFieldTypesDir(dir, { locale: config.locale });
    for (const item of loaded) {
      entries.push({
        name: item.registration.name,
        source: `field-types/${basename(item.path)}`,
        registration: item.registration,
      });
    }
  }
  for (const raw of config.fieldTypes?.entries ?? []) {
    const registration = normalizeFieldTypeRegistration(raw, config.locale);
    entries.push({ name: registration.name, source: 'config (inline)', registration });
  }
  return entries;
}

/** one-line flag summary for a registration */
function flagsOf(registration: FieldTypeRegistration): string {
  const flags: string[] = [];
  if (registration.scalar === true) flags.push('scalar');
  if (registration.relationLike === true) flags.push('relationLike');
  if (registration.ui?.visual !== undefined) flags.push(`visual:${registration.ui.visual}`);
  if (registration.openApiFormat !== undefined) flags.push(`format:${registration.openApiFormat}`);
  if (registration.reverse !== undefined) flags.push('reverse');
  if (registration.storage !== undefined) flags.push('storage');
  if (registration.validate !== undefined) flags.push('validate');
  const attrs = Object.keys(registration.attrs ?? {});
  if (attrs.length > 0) flags.push(`attrs:${attrs.join('|')}`);
  return flags.join(', ');
}

/**
 * `weave field-type:list` — print the effective field-type surface (built-ins +
 * project registrations) with each type's source, base and flags.
 */
export async function fieldTypeList(cwd: string, options: FieldTypeListOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const registered = await collectRegistered(cwd, config);

  const rows: string[][] = [['type', 'source', 'base', 'flags']];
  const payload: Record<string, unknown>[] = [];
  for (const [name, descriptor] of DEFAULT_FIELD_TYPE_REGISTRY) {
    rows.push([name, 'builtin', descriptor.base ?? '-', flagsOf(descriptor)]);
    payload.push({ name, source: 'builtin', base: descriptor.base ?? null, flags: flagsOf(descriptor) });
  }
  for (const entry of registered) {
    rows.push([entry.name, entry.source, entry.registration.base ?? '-', flagsOf(entry.registration)]);
    payload.push({
      name: entry.name,
      source: entry.source,
      base: entry.registration.base ?? null,
      flags: flagsOf(entry.registration),
    });
  }

  p.table(rows);
  p.kv([{ builtin: DEFAULT_FIELD_TYPE_REGISTRY.size }, { registered: registered.length }]);
  p.data({ fieldTypes: payload });
}

/**
 * `weave field-type:check` — validate registrations, the `features.fieldTypes`
 * whitelist, and every `objects/<name>/schema.json` against the effective registry
 * (no database needed). Exits non-zero on any problem.
 */
export async function fieldTypeCheck(cwd: string, options: FieldTypeCheckOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const problems: string[] = [];

  let registered: RegisteredEntry[] = [];
  try {
    registered = await collectRegistered(cwd, config);
    p.log(`registrations OK (${registered.length})`);
  } catch (error) {
    problems.push(`registrations: ${error instanceof Error ? error.message : String(error)}`);
  }

  let fieldTypes: FieldTypeRegistry;
  try {
    fieldTypes = await resolveProjectFieldTypes(cwd, config);
  } catch (error) {
    problems.push(`field types: ${error instanceof Error ? error.message : String(error)}`);
    fieldTypes = DEFAULT_FIELD_TYPE_REGISTRY;
  }

  const whitelist = config.features?.fieldTypes;
  if (whitelist !== undefined) {
    for (const type of whitelist) {
      if (!DEFAULT_FIELD_TYPE_REGISTRY.has(type) && fieldTypes.get(type) === undefined) {
        problems.push(`features.fieldTypes: "${type}" is not a built-in or registered field type`);
      }
    }
    for (const entry of registered) {
      if (!whitelist.includes(entry.name)) {
        p.error(`note: registered type "${entry.name}" is not in features.fieldTypes — it is disabled`);
      }
    }
  }

  try {
    const { registry, files } = await loadSchemaDir(schemaDir, {
      locale: config.locale,
      allowedFieldTypes: whitelist,
      fieldTypes,
    });
    // cross-object checks (relation/details/enum options.from targets) live in buildGraph
    registry.buildGraph({ locale: config.locale });
    p.log(`schemas OK (${files.length} object(s))`);
  } catch (error) {
    problems.push(`schema: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) p.error(problem);
    p.error(`field-type check failed (${problems.length} problem(s))`);
    process.exitCode = 1;
    p.data({ ok: false, problems });
    return;
  }

  p.log('field types OK');
  p.data({ ok: true, problems: [] });
}

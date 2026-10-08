import { basename, join } from 'node:path';
import type { FieldTypeRegistry } from '../../core/index.js';
import { loadEnumsDir, type LoadedEnum } from '../../runtime/enums/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { EnumCheckOptions, EnumListOptions } from '../types/index.js';

/**
 * `weave enum:list` — print the project's named-enum declarations
 * (`enums/<name>.json`): name, values, label locales and source file.
 */
export async function enumList(cwd: string, options: EnumListOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const loaded = await loadEnumsDir(join(schemaDir, 'enums'), { locale: config.locale });

  const rows: string[][] = [['enum', 'values', 'locales', 'source']];
  const payload: Record<string, unknown>[] = [];
  for (const { definition, path } of loaded) {
    const locales = Object.keys(definition.labels ?? {});
    rows.push([definition.name, definition.values.join(', '), locales.join(', ') || '-', `enums/${basename(path)}`]);
    payload.push({
      name: definition.name,
      values: definition.values,
      labels: definition.labels ?? {},
      source: `enums/${basename(path)}`,
    });
  }

  p.table(rows);
  p.kv([{ enums: loaded.length }]);
  p.data({ enums: payload });
}

/**
 * `weave enum:check` — validate every `enums/<name>.json` declaration and every
 * `objects/<name>/schema.json` against them (unresolved `enumType` references
 * and inline/declaration mismatches; no database needed). Exits non-zero on any
 * problem.
 */
export async function enumCheck(cwd: string, options: EnumCheckOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const problems: string[] = [];

  let loaded: LoadedEnum[] = [];
  try {
    loaded = await loadEnumsDir(join(schemaDir, 'enums'), { locale: config.locale });
    p.log(`declarations OK (${loaded.length})`);
  } catch (error) {
    problems.push(`declarations: ${error instanceof Error ? error.message : String(error)}`);
  }

  let fieldTypes: FieldTypeRegistry | undefined;
  try {
    fieldTypes = await resolveProjectFieldTypes(cwd, config);
  } catch (error) {
    problems.push(`field types: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (fieldTypes !== undefined) {
    try {
      const { registry, files } = await loadSchemaDir(schemaDir, {
        locale: config.locale,
        allowedFieldTypes: config.features?.fieldTypes,
        fieldTypes,
      });
      // cross-object checks live in buildGraph; enum references resolve at load
      registry.buildGraph({ locale: config.locale });
      p.log(`schemas OK (${files.length} object(s))`);
    } catch (error) {
      problems.push(`schema: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) p.error(problem);
    p.error(`enum check failed (${problems.length} problem(s))`);
    process.exitCode = 1;
    p.data({ ok: false, problems });
    return;
  }

  p.log('enums OK');
  p.data({ ok: true, problems: [] });
}

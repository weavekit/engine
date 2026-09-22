import kleur from 'kleur';
import { buildMappingReport, createPool, inspectSchema } from '../../core/index.js';
import type { MappingColumn, MappingTable } from '../../core/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { SchemaMapOptions } from '../types/index.js';

/** a column's declared constraints, rendered as one line */
function constraintsOf(col: MappingColumn): string {
  const parts: string[] = [];
  if (col.primary) parts.push('PK');
  if (col.notNull) parts.push('NOT NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);
  if (col.fk !== undefined) parts.push(`FK → ${col.fk.table}.${col.fk.column} ON DELETE ${col.fk.onDelete.toUpperCase()}`);
  return parts.join(' · ') || '-';
}

/** the live-column status cell */
function dbCell(col: MappingColumn): string {
  switch (col.status) {
    case 'ok':
      return kleur.green('ok');
    case 'missing':
      return kleur.red('missing');
    case 'extra':
      return kleur.dim(`extra (${col.actual?.pgType ?? col.pgType})`);
    case 'type':
      return kleur.yellow(`type: ${col.actual?.pgType ?? '?'}`);
    case 'nullable':
      return kleur.yellow(`null: ${col.actual?.notNull === true ? 'not null' : 'nullable'}`);
  }
}

function renderTable(p: SchemaMapOptions['printer'], table: MappingTable, mode: { verbose: boolean; driftOnly: boolean }): void {
  const status = !table.exists
    ? kleur.red('table missing')
    : table.drift
      ? kleur.yellow('drift')
      : kleur.green('in sync');
  const label = table.label !== undefined && table.label !== table.object ? ` ${kleur.dim(`"${table.label}"`)}` : '';
  p.log('');
  p.log(`${kleur.bold(table.object)}${label}  ${kleur.dim('·')} ${status}`);
  for (const warning of table.warnings) p.log(`  ${kleur.red('!')} ${warning}`);

  const columns = mode.driftOnly ? table.columns.filter((col) => col.status !== 'ok') : table.columns;
  const rows: string[][] = [['field', 'schema', 'column', 'pg type', 'constraints', 'db']];
  for (const col of columns) {
    rows.push([col.field, col.schemaType, col.column, col.pgType, constraintsOf(col), dbCell(col)]);
  }
  p.table(rows);

  if (table.details.length > 0) {
    p.log(`  details: ${table.details.map((d) => `${d.field} → ${d.target}`).join(', ')}`);
  }
  if (mode.verbose || table.indexes.some((idx) => !idx.present)) {
    if (table.indexes.length > 0) {
      p.log(
        `  indexes: ${table.indexes
          .map((idx) => `${idx.name} (${idx.method})${idx.present ? '' : ` ${kleur.red('MISSING')}`}`)
          .join(' · ')}`,
      );
    }
    if (table.fks.length > 0) {
      p.log(
        `  fk: ${table.fks
          .map(
            (fk) =>
              `${fk.column} → ${fk.refTable}.${fk.refColumn} ON DELETE ${fk.onDelete.toUpperCase()}${
                fk.present ? '' : ` ${kleur.red('MISSING')}`
              }`,
          )
          .join(' · ')}`,
      );
    }
  }
  if (table.rls !== undefined && (mode.verbose || table.rls.enabled)) {
    p.log(
      `  rls: ${table.rls.enabled ? kleur.green('on') : kleur.dim('off')}  owner: ${table.rls.owner || '-'}  policies: ${
        table.rls.policies.join(', ') || '-'
      }`,
    );
  }
}

/**
 * `weave schema:map [object] [--drift]` — read-only report pairing every schema
 * field with its PostgreSQL column, constraints and live state. Requires a
 * database connection; never emits DDL, never writes.
 */
export async function schemaMap(cwd: string, options: SchemaMapOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    p.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const { registry } = await loadSchemaDir(schemaDir, {
    locale: config.locale,
    allowedFieldTypes: config.features?.fieldTypes,
  });
  const defs = registry.list();
  if (options.object !== undefined && !defs.some((def) => def.name === options.object)) {
    p.error(`unknown object "${options.object}"`);
    process.exitCode = 1;
    return;
  }

  const pool = createPool(databaseUrl);
  let report;
  try {
    const actual = await inspectSchema(pool, { detail: true });
    report = buildMappingReport(defs, actual, config.locale);
  } finally {
    await pool.end();
  }

  let tables = options.object === undefined ? report.tables : report.tables.filter((table) => table.object === options.object);
  if (options.drift === true) tables = tables.filter((table) => table.drift);

  if (p.json) {
    p.data({ tables, totals: report.totals, driftOnly: options.drift === true });
    return;
  }

  if (tables.length === 0) {
    p.log(options.drift === true ? 'no drift — schema and database are in sync' : 'no objects');
    return;
  }

  const mode = { verbose: options.object !== undefined, driftOnly: options.drift === true };
  for (const table of tables) renderTable(p, table, mode);

  const totals = report.totals;
  p.kv([
    { objects: totals.objects, 'tables missing': totals.tablesMissing || undefined },
    {
      fields: totals.columns,
      ok: totals.columnsOk,
      missing: totals.columnsMissing || undefined,
      'type mismatch': totals.columnsType || undefined,
      'null mismatch': totals.columnsNullable || undefined,
      'extra columns': totals.columnsExtra || undefined,
    },
    { 'index drift': totals.indexDrift || undefined, 'fk drift': totals.fkDrift || undefined },
  ]);
}

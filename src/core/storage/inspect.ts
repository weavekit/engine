import type { Pool } from 'pg';

export interface ActualColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  /** pg type name (`udt_name`): distinguishes arrays (`_text`), enums, domains */
  udtName?: string;
  /** numeric precision (numeric/decimal); null when not numeric */
  numericPrecision?: number | null;
  /** numeric scale (numeric/decimal); null when not numeric */
  numericScale?: number | null;
  /** enum labels when the column is a user-defined enum (detail only) */
  enumLabels?: string[];
  /** column comment (detail only) */
  comment?: string;
}

export interface ActualFk {
  column: string;
  refTable: string;
  refColumn: string;
  /** FK ON DELETE action (detail only): cascade | set_null | restrict | no_action | set_default */
  onDelete?: string;
}

export interface ActualTable {
  name: string;
  columns: ActualColumn[];
  pk: string[];
  fks: ActualFk[];
  indexNames: string[];
  /** owning role name (for RLS ownership gating); present when the table exists */
  owner?: string;
  /** whether row-level security is enabled */
  rlsEnabled?: boolean;
  /** policy names on the table */
  rlsPolicies?: string[];
  /** roles granted SELECT (for the restricted-SQL role grant) */
  selectGrantedTo?: string[];
  /** table comment (detail only) */
  comment?: string;
  /** single-column unique (non-primary) columns (detail only) */
  uniqueColumns?: string[];
}

export interface InspectOptions {
  /**
   * fetch extra catalog detail used by reverse modeling (`weave introspect`):
   * enum labels, table/column comments, single-column unique constraints and
   * FK on-delete actions. Off by default so `migrate`/drift checks run zero
   * extra queries.
   */
  detail?: boolean;
}

/** map a pg `confdeltype` char to a readable action name */
const FK_DELETE_ACTIONS: Record<string, string> = {
  a: 'no_action',
  r: 'restrict',
  c: 'cascade',
  n: 'set_null',
  d: 'set_default',
};

/** read the current schema of every table in the connection's schema */
export async function inspectSchema(pool: Pool, options: InspectOptions = {}): Promise<Map<string, ActualTable>> {
  const tables = new Map<string, ActualTable>();

  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default,
            udt_name, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  );
  for (const row of cols.rows as {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    udt_name: string | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
  }[]) {
    const t = tables.get(row.table_name) ?? {
      name: row.table_name,
      columns: [],
      pk: [],
      fks: [],
      indexNames: [],
      owner: '',
      rlsEnabled: false,
      rlsPolicies: [],
      selectGrantedTo: [],
    };
    t.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default,
      udtName: row.udt_name ?? undefined,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
    });
    tables.set(row.table_name, t);
  }

  const pkRows = await pool.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema()`,
  );
  for (const row of pkRows.rows as { table_name: string; column_name: string }[]) {
    tables.get(row.table_name)?.pk.push(row.column_name);
  }

  const fkRows = await pool.query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`,
  );
  for (const row of fkRows.rows as {
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
  }[]) {
    tables.get(row.table_name)?.fks.push({
      column: row.column_name,
      refTable: row.ref_table,
      refColumn: row.ref_column,
    });
  }

  const idxRows = await pool.query(
    `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  for (const row of idxRows.rows as { tablename: string; indexname: string }[]) {
    tables.get(row.tablename)?.indexNames.push(row.indexname);
  }

  // RLS state + ownership per table
  const rlsRows = await pool.query(
    `SELECT c.relname, c.relrowsecurity, r.rolname AS owner
       FROM pg_class c
       JOIN pg_roles r ON c.relowner = r.oid
      WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace`,
  );
  for (const row of rlsRows.rows as { relname: string; relrowsecurity: boolean; owner: string }[]) {
    const t = tables.get(row.relname);
    if (t !== undefined) {
      t.rlsEnabled = row.relrowsecurity;
      t.owner = row.owner;
    }
  }

  const policyRows = await pool.query(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = current_schema()`,
  );
  for (const row of policyRows.rows as { tablename: string; policyname: string }[]) {
    const t = tables.get(row.tablename);
    if (t !== undefined) (t.rlsPolicies ??= []).push(row.policyname);
  }

  // roles granted SELECT (for the restricted-SQL role grant; PUBLIC grants are
  // ignored — if PUBLIC has SELECT the role inherits it, and a redundant GRANT
  // would just be emitted)
  const grantRows = await pool.query(
    `SELECT c.relname AS table_name, r.rolname AS role
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
       JOIN pg_roles r ON r.oid = acl.grantee
      WHERE n.nspname = current_schema() AND acl.privilege_type = 'SELECT'`,
  );
  for (const row of grantRows.rows as { table_name: string; role: string }[]) {
    const t = tables.get(row.table_name);
    if (t !== undefined) (t.selectGrantedTo ??= []).push(row.role);
  }

  if (options.detail === true) {
    await loadDetail(pool, tables);
  }

  return tables;
}

/**
 * Extra catalog reads for reverse modeling (enum labels, comments, single-column
 * unique constraints, FK on-delete actions). Runs only when `detail` is set so
 * `migrate`/drift checks stay query-lean.
 */
async function loadDetail(pool: Pool, tables: Map<string, ActualTable>): Promise<void> {
  const enumRows = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name, e.enumlabel AS label
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       JOIN pg_type t ON a.atttypid = t.oid
       JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum, e.enumsortorder`,
  );
  for (const row of enumRows.rows as { table_name: string; column_name: string; label: string }[]) {
    const col = tables.get(row.table_name)?.columns.find((c) => c.name === row.column_name);
    if (col !== undefined) (col.enumLabels ??= []).push(row.label);
  }

  const tableComments = await pool.query(
    `SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
  );
  for (const row of tableComments.rows as { table_name: string; comment: string | null }[]) {
    const t = tables.get(row.table_name);
    if (t !== undefined && row.comment !== null) t.comment = row.comment;
  }

  const columnComments = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name, col_description(c.oid, a.attnum) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
  );
  for (const row of columnComments.rows as { table_name: string; column_name: string; comment: string | null }[]) {
    const col = tables.get(row.table_name)?.columns.find((c) => c.name === row.column_name);
    if (col !== undefined && row.comment !== null) col.comment = row.comment;
  }

  const uniqueRows = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON i.indrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = current_schema() AND i.indisunique AND NOT i.indisprimary AND i.indnkeyatts = 1`,
  );
  for (const row of uniqueRows.rows as { table_name: string; column_name: string }[]) {
    const t = tables.get(row.table_name);
    if (t !== undefined) (t.uniqueColumns ??= []).push(row.column_name);
  }

  const fkDeleteRows = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name, con.confdeltype
       FROM pg_constraint con
       JOIN pg_class c ON con.conrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      WHERE con.contype = 'f' AND n.nspname = current_schema()`,
  );
  for (const row of fkDeleteRows.rows as { table_name: string; column_name: string; confdeltype: string }[]) {
    const fk = tables.get(row.table_name)?.fks.find((f) => f.column === row.column_name);
    if (fk !== undefined) fk.onDelete = FK_DELETE_ACTIONS[row.confdeltype] ?? 'restrict';
  }
}

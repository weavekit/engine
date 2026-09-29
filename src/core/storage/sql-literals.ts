/**
 * SQL literal/identifier quoting — the single source for turning a value into a
 * safe PostgreSQL token in generated DDL. Never interpolate raw values into DDL.
 */

/** quote a string as a single-quoted PostgreSQL literal (doubles embedded quotes) */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** quote an identifier (doubles embedded double quotes) */
export function sqlIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

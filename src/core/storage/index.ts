export { createPool } from './pool.js';
export { inspectSchema } from './inspect.js';
export type { ActualColumn, ActualFk, ActualTable, InspectOptions } from './inspect.js';
export { mapToSchema } from './introspect.js';
export type {
  IntrospectedObject,
  IntrospectMapOptions,
  IntrospectReport,
  IntrospectSkip,
} from './introspect.js';
export { buildExpectedTable, diffTable, diffAll, diffRls } from './diff.js';
export type {
  ExpectedColumn,
  ExpectedFk,
  ExpectedIndex,
  ExpectedTable,
} from './diff.js';
export { pgType, defaultExpr, onDeleteClause, pgTypeMatches } from './map.js';
export {
  RECORD_META_COLUMNS,
  RECORD_META_DEFAULT_STATUS,
  RECORD_META_ID_FIELD,
  RECORD_META_TABLE_PREFIX,
  RECORD_META_VIRTUAL_FIELDS,
  RECORD_META_VIRTUAL_FIELD_SPECS,
  RECORD_META_VIRTUAL_PREFIX,
  buildRecordMetaTable,
  isRecordMetaTable,
  isRecordMetaVirtualField,
  isSideTableVirtualField,
  recordMetaTableName,
} from './record-meta.js';
export type { RecordMetaVirtualFieldSpec } from './record-meta.js';
export { pkValueTextSql, recordKeySql } from './record-key-sql.js';
export { buildMappingReport } from './report.js';
export { analyzeImpact, IMPACT_RISKS } from './impact.js';
export type { SchemaImpact, ImpactRisk, ColumnAdd } from './impact.js';
export type {
  MappingColumn,
  MappingColumnStatus,
  MappingFk,
  MappingIndex,
  MappingReport,
  MappingRls,
  MappingTable,
  MappingTotals,
} from './report.js';
export { setMeta, getMeta } from './meta.js';
export { applyStatements } from './apply.js';
export type { SqlQueryable } from './queryable.js';
export { sqlLiteral, sqlIdent } from './sql-literals.js';
export {
  LINK_TABLE_PREFIX,
  LINK_IDX_COLUMN,
  linkTableName,
  isLinkTable,
  linkOwnerColumn,
  linkTargetColumn,
  multiRelationsOf,
  buildLinkTable,
  buildLinkTables,
} from './link-table.js';
export { SYSTEM_TABLES, SYSTEM_TABLE_NAMES, buildSystemTables, systemHardeningStatements } from './system-tables.js';
export { migrate } from './migrate.js';
export type { MigrateOptions, MigrationResult } from './migrate.js';

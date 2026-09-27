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
export { ensureMetaTable, setMeta } from './meta.js';
export { applyStatements } from './apply.js';
export { migrate } from './migrate.js';
export type { MigrateOptions, MigrationResult } from './migrate.js';

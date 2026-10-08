import { describe, it, expect } from '../helpers/test.js';
import * as engine from '../../src/index.js';
import { DEFAULT_LOCALE } from '../../src/core/i18n/index.js';

/**
 * G1 contract-freeze gate. These are the single-source contract values frozen at
 * 1.0 — additive changes are allowed, but any change here is a **breaking**
 * change and must bump `CONTRACT_VERSION` (see the contract-freeze doc). This
 * test fails loudly if a frozen value drifts.
 */
describe('G1 contract freeze', () => {
  it('frozen format/revision version markers', () => {
    expect(engine.CONTRACT_VERSION).toBe(1);
    expect(engine.SCHEMA_FORMAT_VERSION).toBe(6);
    expect(engine.WORKFLOW_FORMAT_VERSION).toBe(2);
    expect(engine.CURSOR_VERSION).toBe(1);
  });

  it('frozen MCP tool names', () => {
    expect(engine.REGISTRY_TOOLS).toEqual({
      SEARCH: 'search_records',
      GET: 'get_record',
      CREATE: 'create_record',
      UPDATE: 'update_record',
      DELETE: 'delete_record',
    });
    expect(engine.INTROSPECTION_TOOLS).toEqual({ LIST_OBJECTS: 'list_objects', DESCRIBE_OBJECT: 'describe_object' });
    expect(engine.WORKFLOW_TOOLS).toEqual({ TRANSITION: 'workflow_transition' });
  });

  it('frozen event types', () => {
    expect(engine.EVENT_TYPES).toEqual({
      RECORD_CREATED: 'record.created',
      RECORD_UPDATED: 'record.updated',
      RECORD_DELETED: 'record.deleted',
      RECORD_TRANSITIONED: 'record.transitioned',
      AUDIT_EVENT: 'audit.event',
      SCHEMA_CHANGED: 'schema.changed',
      SCHEMA_DRIFT: 'schema.drift',
      LIFECYCLE_SHUTDOWN: 'lifecycle.shutdown',
    });
  });

  it('frozen execution/pipeline + audit constants', () => {
    expect(Object.values(engine.EXECUTION_STAGES)).toEqual([
      'plan', 'validate', 'authorize', 'guardrail', 'approval', 'execute', 'commit', 'evidence',
    ]);
    expect(Object.values(engine.AUDIT_MODES)).toEqual(['best-effort', 'transactional', 'durable']);
    expect(engine.QUERY_BUDGET_DEFAULTS.maxRows).toBe(1000);
  });

  it('frozen RBAC/data-access values', () => {
    expect(engine.READ_SCOPES).toEqual({ OWN: 'own', DEPARTMENT: 'department', ALL: 'all' });
    expect(engine.ROW_SCOPE_MARKERS).toEqual({ OWNERSHIP: 'ownership', DEPARTMENT: 'department', TENANT: 'tenant' });
    expect(Object.values(engine.FILTER_OPS).sort()).toEqual(['contains', 'eq', 'gt', 'gte', 'in', 'like', 'lt', 'lte', 'ne']);
  });

  it('public runtime export surface is present', () => {
    const names = [
      'version', 'CONTRACT_VERSION',
      'createEngine', 'buildEngineFromRegistry', 'createPool', 'migrate', 'loadSchemaDir',
      'createDataAccess', 'withRbac', 'withTx', 'executeRestrictedSql', 'enforceSqlGates',
      'resolvePermissionFor', 'buildRowScope', 'userPrincipal', 'systemPrincipal', 'SYSTEM_CAPABILITIES',
      'principalSubject', 'principalActorId', 'principalTenantId', 'tenantOf', 'subjectOf', 'scopedQuotaKey',
      'mapSchemaError', 'NOOP_AUDIT_SINK', 'AUDIT_MODES',
      'EXECUTION_STAGES', 'runPipeline', 'validateToolArgs', 'QUERY_BUDGET_DEFAULTS', 'resolveQueryBudget',
      'encodeCursor', 'decodeCursor', 'CURSOR_VERSION', 'REGISTRY_TOOLS', 'INTROSPECTION_TOOLS', 'WORKFLOW_TOOLS',
      'EVENT_TYPES', 'createAuth', 'createDirectoryAuthenticator',
    ];
    for (const name of names) {
      expect((engine as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('representative error keys are frozen', () => {
    for (const key of [
      'data.recordNotFound', 'data.objectUnknown', 'rbac.denied.read', 'rbac.denied.field',
      'auth.missingKey', 'auth.invalidKey', 'http.param.invalid', 'http.rateLimited', 'http.internal',
      'data.schemaDrift', 'script.abort', 'tool.args.invalid', 'object.action.pending', 'query.budget.exceeded',
    ]) {
      const err = new engine.SchemaError(key as never, {}, DEFAULT_LOCALE);
      expect(err.localize(DEFAULT_LOCALE)).toBeTruthy();
    }
  });
});

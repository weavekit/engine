import type { ObjectRegistry } from './core/index.js';
import { createPool } from './core/index.js';
import {
  autoCommit,
  buildCommitMessage,
  diffMetadata,
  gitCommitAuthor,
  loadSchemaDir,
  recordSchemaChanges,
  syncSchema,
} from './runtime/git/index.js';
import { resolveFieldTypeRegistry } from './runtime/fieldtypes/index.js';
import { buildEngineFromRegistry, resolveLocale } from './runtime/engine.js';
import type { EngineConfig, WeaveKitEngine } from './runtime/engine.js';
import { resolve } from 'node:path';

// Stable surface (contract): app/integration authors depend on these. Internals
// live in `./experimental.js` (unstable) or stay unexported — see docs/reference/public-api.md.
export * from './core/index.js';
export * from './core/api/index.js';
export * from './runtime/data-access/index.js';
export * from './runtime/git/index.js';
export * from './runtime/tools/index.js';
export * from './runtime/proxy/index.js';
export * from './runtime/engine.js';
export * from './adapters/auth/index.js';
export * from './adapters/rest/index.js';
export * from './adapters/mcp/index.js';
export * from './adapters/events/index.js';
export { buildOpenApiDocument, capabilitiesFromConfig } from './adapters/openapi/index.js';
export type {
  BuildOpenApiInput,
  OpenApiCapabilities,
  OpenApiDocument,
} from './adapters/openapi/index.js';
export type { AuditEngine, AuditFilter, AuditQuery, AuditQueryResult } from './subsystems/audit/index.js';
export type {
  LoadedScript,
  ResolvedScriptConfig,
  RpcExecutor,
  RpcRequest,
  SandboxBackend,
  SandboxCallResult,
  SandboxEntry,
  SandboxInstance,
  ScriptBridgeOptions,
  ScriptDispatcherOptions,
} from './subsystems/script/index.js';
export { scaffoldProject } from './cli/scaffold.js';
export type { ScaffoldProjectOptions, ScaffoldProjectResult } from './cli/scaffold.js';
export { loadFieldTypesDir, normalizeFieldTypeRegistration, resolveFieldTypeRegistry } from './runtime/fieldtypes/index.js';
export type { LoadedFieldType } from './runtime/fieldtypes/index.js';
export { PROJECT_TYPES } from './cli/types/values.js';
export type { ProjectType } from './cli/types/values.js';

export { version } from './version.js';

/**
 * Assemble an engine from a config: load the schema from `schemaDir`
 * (default `.` — the project root's `objects/` directory), then build the
 * RBAC-decorated data-access layer and expose the REST/MCP interfaces.
 *
 * Load-only by default: WeaveKit bridges your database without touching it —
 * DDL (CREATE/ALTER) runs only when `migrate.auto` is enabled (greenfield) or
 * via an explicit `weave migrate`.
 */
export async function createEngine(config: EngineConfig): Promise<WeaveKitEngine> {
  const locale = resolveLocale(config.locale);
  const dir = config.schemaDir ?? '.';

  // open registration: compile built-ins + project-local registrations into an
  // immutable effective registry (explicit injection — no mutable global).
  const fieldTypes = await resolveFieldTypeRegistry({
    dir: config.fieldTypes?.dir === undefined ? undefined : resolve(dir, config.fieldTypes.dir),
    entries: config.fieldTypes?.entries,
    locale,
  });

  let registry: ObjectRegistry;
  if (config.migrate?.auto === true) {
    const sync = await syncSchema({
      dir,
      databaseUrl: config.databaseUrl,
      locale,
      allowedFieldTypes: config.features?.fieldTypes,
      fieldTypes,
    });
    registry = sync.registry;
    if (config.commit?.meta === true) {
      const changes = await diffMetadata(dir, sync.files, locale);
      const commit = await autoCommit({
        dir,
        message: buildCommitMessage(changes),
        identity: config.commit?.identity,
        locale,
      });
      if (commit.committed && changes.length > 0) {
        const author = await gitCommitAuthor(dir);
        // reached only after a successful sync, which required a DB URL
        const pool = createPool(config.databaseUrl ?? process.env.DATABASE_URL!);
        try {
          await recordSchemaChanges(pool, changes, sync.files, {
            sha: commit.sha,
            author,
            applied: sync.migration.applied,
          });
        } finally {
          await pool.end();
        }
      }
    }
  } else {
    const { registry: loaded } = await loadSchemaDir(dir, {
      locale,
      allowedFieldTypes: config.features?.fieldTypes,
      fieldTypes,
    });
    loaded.buildGraph({ locale });
    registry = loaded;
  }

  return buildEngineFromRegistry(registry, config);
}

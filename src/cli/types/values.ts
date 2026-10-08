/**
 * CLI enum-like constants — single source of truth (`as const`, FORMULA_TYPES /
 * core/types/values.ts style). Every union below is derived from its const,
 * so the value set lives in exactly one place.
 */

/** weave subcommand names */
export const WEAVE_COMMANDS = {
  MIGRATE: 'migrate',
  DEV: 'dev',
  BUILD: 'build',
  TEST: 'test',
  TYPES: 'types',
  OBJECT_CREATE: 'object:create',
  FIELD_ADD: 'field:add',
  FIELD_TYPE_LIST: 'field-type:list',
  FIELD_TYPE_CHECK: 'field-type:check',
  ENUM_LIST: 'enum:list',
  ENUM_CHECK: 'enum:check',
  MODULE_ADD: 'module:add',
  MODULE_REMOVE: 'module:remove',
  WORKFLOW_OPEN: 'workflow:open',
  WORKFLOW_CLOSE: 'workflow:close',
  WORKFLOW_SWITCH: 'workflow:switch',
  WORKFLOW_UPGRADE: 'workflow:upgrade',
  PAGES_MIGRATE: 'pages:migrate',
  CONNECT: 'connect',
  INTROSPECT: 'introspect',
  MCP_CONFIG: 'mcp:config',
  SCHEMA_MAP: 'schema:map',
  SCHEMA_UPGRADE: 'schema:upgrade',
  SYNC_IDENTITY: 'sync:identity',
  IDENTITY_LIST: 'identity:list',
  IDENTITY_CREATE: 'identity:create',
  IDENTITY_DISABLE: 'identity:disable',
  IDENTITY_ENABLE: 'identity:enable',
  OPENAPI: 'openapi',
  GRAPHQL_SCHEMA: 'graphql:schema',
} as const;
export type WeaveCommand = typeof WEAVE_COMMANDS[keyof typeof WEAVE_COMMANDS];

/** `weave init --type` project-starting presets (core is never trimmed) */
export const PROJECT_TYPES = {
  AGENT: 'agent',
  GOVERNANCE: 'governance',
  SERVICE: 'service',
  BUSINESS: 'business',
} as const;
export type ProjectType = typeof PROJECT_TYPES[keyof typeof PROJECT_TYPES];

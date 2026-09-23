import type { CliPrinter } from '../render.js';

/** `weave migrate` options */
export interface MigrateOptions {
  /** generate DDL without executing */
  dryRun?: boolean;
  printer: CliPrinter;
}

/** `weave dev` options */
export interface DevOptions {
  /** HTTP port (defaults to 3000) */
  port: number;
  printer: CliPrinter;
}

/** `weave build` options */
export interface BuildOptions {
  /** server entry file (defaults to main.ts) */
  entry?: string;
  printer: CliPrinter;
}

/** `weave test` options */
export interface TestOptions {
  /** extra arguments forwarded to `bun test` */
  args: string[];
  printer: CliPrinter;
}

/** `weave types` options */
export interface TypeOptions {
  /** output directory; defaults to `generated` under the project root */
  outdir?: string;
  printer: CliPrinter;
}

/** `weave object:create` options */
export interface ObjectCreateOptions {
  printer: CliPrinter;
}

/** `weave field:add` options */
export interface FieldAddOptions {
  /** snake_case field name */
  name: string;
  /** field type (one of FIELD_TYPES) */
  type: string;
  /** mark the field required */
  required?: boolean;
  /** add a UNIQUE constraint */
  unique?: boolean;
  /** default value (parsed per type) */
  default?: string;
  /** comma-separated options (enum) */
  options?: string;
  /** data-driven enum source: `<object>` or `<object>.<column>` */
  optionsFrom?: string;
  /** target object name (relation / multiRelation) */
  target?: string;
  printer: CliPrinter;
}

/** `weave module:add` / `weave module:remove` options */
export interface ModuleOptions {
  printer: CliPrinter;
}

/** `weave field-type:list` options */
export interface FieldTypeListOptions {
  printer: CliPrinter;
}

/** `weave field-type:check` options */
export interface FieldTypeCheckOptions {
  printer: CliPrinter;
}

/** `weave introspect` options */
export interface IntrospectOptions {
  /** output directory; defaults to `<schemaDir>/objects` */
  out?: string;
  /** comma-separated table names to include */
  include?: string;
  /** comma-separated table names to exclude */
  exclude?: string;
  /** overwrite existing `objects/<name>/schema.json` */
  force?: boolean;
  /** report only, do not write */
  dryRun?: boolean;
  /** auto-commit the generated metadata (default true; `--no-commit` disables) */
  commit?: boolean;
  printer: CliPrinter;
}

/** `weave mcp:config` options */
export interface McpConfigOptions {
  /** target host: claude-code | claude-desktop | cursor | vscode | stdio | curl (default: all) */
  host?: string;
  /** full MCP URL; defaults to `http://localhost:<port><mcp.endpoint>` */
  url?: string;
  /** engine port used to build the default URL (default 3000) */
  port?: number;
  /** API key; defaults to the first static key in `auth.source` */
  key?: string;
  /** on-behalf-of ref; defaults to the first key of `mcp.identities` */
  identity?: string;
  printer: CliPrinter;
}

/** `weave schema:map` options */
export interface SchemaMapOptions {
  /** restrict the report to one object (table) */
  object?: string;
  /** show only drifting columns and tables */
  drift?: boolean;
  printer: CliPrinter;
}

/** `weave schema:upgrade` options */
export interface SchemaUpgradeOptions {
  /** report what would change without writing files */
  dryRun?: boolean;
  printer: CliPrinter;
}

/** `weave openapi` options */
export interface OpenApiOptions {
  /** output file; `-` prints to stdout (default: `openapi.json` in the project root) */
  out?: string;
  /** omit per-object component schemas (generic reference) */
  generic?: boolean;
  /** server URL written into the document (default: http://localhost:3000) */
  server?: string;
  printer: CliPrinter;
}

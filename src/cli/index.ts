#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { Command } from 'commander';
import { version } from '../index.js';
import { loadEnvFile } from './env.js';
import { build } from './commands/build.js';
import { connect } from './commands/connect.js';
import { dev } from './commands/dev.js';
import { fieldAdd } from './commands/field-add.js';
import { introspect } from './commands/introspect.js';
import { mcpConfig } from './commands/mcp-config.js';
import { migrate } from './commands/migrate.js';
import { moduleToggle } from './commands/module.js';
import { objectCreate } from './commands/object-create.js';
import { openapi } from './commands/openapi.js';
import { migratePages } from './commands/pages-migrate.js';
import { schemaMap } from './commands/schema-map.js';
import { schemaUpgrade } from './commands/schema-upgrade.js';
import { test } from './commands/test.js';
import { types } from './commands/types.js';
import { createPrinter } from './render.js';
import { WEAVE_COMMANDS } from './types/index.js';

// enable TS imports (weavekit.config.ts / main.ts) — the CLI ships tsx as a
// runtime dependency so it can load the project's TypeScript config on Node
register();
loadEnvFile(process.cwd());

const program = new Command();
program
  .name('weave')
  .description('WeaveKit CLI — metadata-driven headless backend')
  .version(version)
  .option('--json', 'emit structured JSON output');

const jsonRequested = (): boolean => program.opts<{ json?: boolean }>().json === true;
const printer = (): ReturnType<typeof createPrinter> => createPrinter({ json: jsonRequested() });

async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    printer().error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program
  .command(WEAVE_COMMANDS.MIGRATE)
  .description('sync metadata to PostgreSQL (Git → PG) and auto-commit')
  .option('--dry-run', 'generate DDL without executing')
  .action(async (opts: { dryRun?: boolean }) => {
    await runAction(() => migrate(process.cwd(), { dryRun: opts.dryRun, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.DEV)
  .description('run the engine with hot reload')
  .option('--port <number>', 'HTTP port', process.env.PORT ?? '3000')
  .action(async (opts: { port: string }) => {
    await runAction(() => dev(process.cwd(), { port: Number(opts.port), printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.BUILD)
  .description('bundle the server entry for production')
  .option('--entry <file>', 'server entry', 'main.ts')
  .action(async (opts: { entry?: string }) => {
    await runAction(() => build(process.cwd(), { entry: opts.entry, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.TEST)
  .description('run the project test suite (proxies `bun test`)')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (_opts: unknown, command: Command) => {
    const args = (command.args as string[]).slice(1);
    await runAction(() => test(process.cwd(), { args, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.TYPES)
  .description('compile schema.json into object-level TS types (generated/types.ts)')
  .option('--outdir <dir>', 'output directory (default: generated)', 'generated')
  .action(async (opts: { outdir?: string }) => {
    await runAction(() => types(process.cwd(), { outdir: opts.outdir, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.INTROSPECT)
  .description('reverse-model an existing PostgreSQL database into objects/<table>/schema.json (read-only; alter:false)')
  .option('--out <dir>', 'output directory (default: <schemaDir>/objects)')
  .option('--include <tables>', 'comma-separated table names to include')
  .option('--exclude <tables>', 'comma-separated table names to exclude')
  .option('--force', 'overwrite existing objects/<name>/schema.json')
  .option('--dry-run', 'report only, do not write')
  .option('--no-commit', 'do not auto-commit generated metadata')
  .action(async (opts: { out?: string; include?: string; exclude?: string; force?: boolean; dryRun?: boolean; commit?: boolean }) => {
    await runAction(() =>
      introspect(process.cwd(), {
        out: opts.out,
        include: opts.include,
        exclude: opts.exclude,
        force: opts.force,
        dryRun: opts.dryRun,
        commit: opts.commit,
        printer: printer(),
      }),
    );
  });

program
  .command(WEAVE_COMMANDS.MCP_CONFIG)
  .description("print ready-to-paste config connecting an MCP host (Claude Code/Cursor/VS Code/...) to this project's /mcp endpoint")
  .option('--host <host>', 'claude-code|claude-desktop|cursor|vscode|stdio|curl (default: all)')
  .option('--url <url>', 'full MCP URL (default: http://localhost:<port><mcp.endpoint>)')
  .option('--port <number>', 'engine port for the default URL', '3000')
  .option('--key <key>', 'API key (default: first static key in auth.source)')
  .option('--identity <ref>', 'on-behalf-of ref (default: first mcp.identities key)')
  .action(async (opts: { host?: string; url?: string; port: string; key?: string; identity?: string }) => {
    await runAction(() =>
      mcpConfig(process.cwd(), {
        host: opts.host,
        url: opts.url,
        port: Number(opts.port),
        key: opts.key,
        identity: opts.identity,
        printer: printer(),
      }),
    );
  });

program
  .command(`${WEAVE_COMMANDS.SCHEMA_MAP} [object]`)
  .description('read-only report mapping schema fields to PostgreSQL columns (per object, or one table)')
  .option('--drift', 'show only drifting columns and tables')
  .action(async (object: string | undefined, opts: { drift?: boolean }) => {
    await runAction(() => schemaMap(process.cwd(), { object, drift: opts.drift, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.SCHEMA_UPGRADE)
  .description('upgrade objects/*/schema.json to the current on-disk format version and auto-commit')
  .option('--dry-run', 'report what would change without writing files')
  .action(async (opts: { dryRun?: boolean }) => {
    await runAction(() => schemaUpgrade(process.cwd(), { dryRun: opts.dryRun, printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.OPENAPI)
  .description("emit an OpenAPI 3.1 document for this project's REST API (no database needed)")
  .option('--out <file>', 'output file; "-" prints to stdout', 'openapi.json')
  .option('--generic', 'omit per-object component schemas (generic reference)')
  .option('--server <url>', 'server URL written into the document')
  .action(async (opts: { out?: string; generic?: boolean; server?: string }) => {
    await runAction(() =>
      openapi(process.cwd(), { out: opts.out, generic: opts.generic, server: opts.server, printer: printer() }),
    );
  });

program
  .command(`${WEAVE_COMMANDS.OBJECT_CREATE} <name>`)
  .description('scaffold an object: objects/<name>/schema.json + server.js sandbox hooks (+ client.js UI template for business projects)')
  .action(async (name: string) => {
    await runAction(() => objectCreate(process.cwd(), name, { printer: printer() }));
  });

program
  .command(`${WEAVE_COMMANDS.FIELD_ADD} <object>`)
  .description('add a field to an object (objects/<name>/schema.json) and auto-commit')
  .requiredOption('--name <field>', 'snake_case field name')
  .requiredOption('--type <type>', 'field type (string/text/integer/number/currency/boolean/datetime/date/json/enum/relation/multiRelation/seq_no)')
  .option('--required', 'mark the field required')
  .option('--unique', 'add a UNIQUE constraint')
  .option('--default <value>', 'default value (parsed per type)')
  .option('--options <a,b,c>', 'comma-separated options (enum)')
  .option('--target <object>', 'target object (relation / multiRelation)')
  .action(async (object: string, opts: { name: string; type: string; required?: boolean; unique?: boolean; default?: string; options?: string; target?: string }) => {
    await runAction(() =>
      fieldAdd(process.cwd(), object, {
        name: opts.name,
        type: opts.type,
        required: opts.required,
        unique: opts.unique,
        default: opts.default,
        options: opts.options,
        target: opts.target,
        printer: printer(),
      }),
    );
  });

program
  .command(`${WEAVE_COMMANDS.MODULE_ADD} <name>`)
  .description('enable a subsystem (audit/script) in weavekit.config.ts and auto-commit')
  .action(async (name: string) => {
    await runAction(() => moduleToggle(process.cwd(), name, true, { printer: printer() }));
  });

program
  .command(`${WEAVE_COMMANDS.MODULE_REMOVE} <name>`)
  .description('disable a subsystem (audit/script) in weavekit.config.ts and auto-commit')
  .action(async (name: string) => {
    await runAction(() => moduleToggle(process.cwd(), name, false, { printer: printer() }));
  });

// `pages:*` is UI-related and pre-release: intentionally undocumented (see AGENTS.md), kept functional.
program
  .command(WEAVE_COMMANDS.PAGES_MIGRATE)
  .description('migrate legacy flat custom pages (pages/<id>.layout.json) to directories (pages/<id>/layout.json) and auto-commit')
  .action(async () => {
    await runAction(() => migratePages(process.cwd(), { printer: printer() }));
  });

program
  .command(WEAVE_COMMANDS.CONNECT)
  .description('connect a local engine to a governance tunnel endpoint (reverse tunnel for NAT\'d/on-prem engines)')
  .requiredOption('--endpoint <url>', 'governance tunnel endpoint (http/https)')
  .requiredOption('--tunnel <id>', 'connections.tunnel_id')
  .requiredOption('--token <token>', 'connections.pairing_token')
  .requiredOption('--engine <url>', 'local customer engine base url')
  .requiredOption('--api-key <key>', 'customer engine api key')
  .option('--insecure', 'skip TLS certificate verification (dev/self-hosted)')
  .action(async (opts: { endpoint: string; tunnel: string; token: string; engine: string; apiKey?: string; insecure?: boolean }) => {
    await runAction(() =>
      connect(process.cwd(), {
        endpoint: opts.endpoint,
        tunnel: opts.tunnel,
        token: opts.token,
        engine: opts.engine,
        apiKey: opts.apiKey,
        insecure: opts.insecure,
      }),
    );
  });

await program.parseAsync(process.argv);

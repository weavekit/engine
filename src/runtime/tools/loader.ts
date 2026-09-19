import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SchemaError, TOOL_NAME_PATTERN, isReservedToolName } from '../../core/index.js';
import type { Locale, ToolDefinition } from '../../core/index.js';

/**
 * Tool loader (`toolsDir`). Dynamic-imports a directory of tool modules whose
 * default export satisfies `ToolDefinition`. Startup validation is structural
 * only: name format, reserved-name collision, description/inputSchema/handler
 * presence. `roles` is an allow-list and is NOT validated (the engine has no
 * role registry) — a single informational warn is emitted per tool.
 *
 * Node runtime import constraint: the engine loads compiled products
 * (`.js/.mjs/.cjs`); `.ts` is accepted when a tsx/loader is registered (dev).
 * The CLI (`weave dev/build`) compiles `tools/*.ts` for production.
 */

const TOOL_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

export interface LoadedTool {
  /** absolute path of the tool module */
  path: string;
  /** validated tool definition */
  definition: ToolDefinition;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(detail: string, locale?: Locale): SchemaError {
  return new SchemaError('tools.tool.invalid', { detail }, locale);
}

/** structural validation of a tool module's default export */
export function validateToolDefinition(raw: unknown, locale?: Locale): ToolDefinition {
  if (!isPlainObject(raw)) {
    throw invalid('tool module must default-export a plain object', locale);
  }
  const { name, description, inputSchema, roles, handler } = raw;

  if (typeof name !== 'string') {
    throw new SchemaError('tools.tool.name.invalid', { name: String(name ?? ''), pattern: TOOL_NAME_PATTERN }, locale);
  }
  // reserved-name collision (incl. the `mcp.` audit namespace) reported before
  // the pattern so `mcp.<x>` names surface the explicit reserved error
  if (isReservedToolName(name)) {
    throw new SchemaError('tools.tool.name.reserved', { name }, locale);
  }
  if (!new RegExp(TOOL_NAME_PATTERN).test(name)) {
    throw new SchemaError('tools.tool.name.invalid', { name, pattern: TOOL_NAME_PATTERN }, locale);
  }
  if (typeof description !== 'string') {
    throw invalid(`"${String(name)}" requires a string description`, locale);
  }
  if (typeof handler !== 'function') {
    throw new SchemaError('tools.tool.handler.missing', { name }, locale);
  }
  if (!isPlainObject(inputSchema)) {
    throw new SchemaError('tools.tool.schema.invalid', { name }, locale);
  }
  if (roles !== undefined && (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string'))) {
    throw invalid(`"${String(name)}" roles must be a string array`, locale);
  }
  if (roles !== undefined) {
    // allow-list semantics; the engine cannot validate roles, so just inform
    console.warn(
      `[weavekit:tools] tool "${name}" roles are an allow-list — roles not listed here never see this tool`,
    );
  }

  return {
    name,
    description,
    inputSchema: inputSchema as ToolDefinition['inputSchema'],
    roles: roles as string[] | undefined,
    handler: handler as ToolDefinition['handler'],
  };
}

async function collectToolFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (TOOL_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(join(dir, entry.name));
  }
}

/** load + validate every tool module under a directory (missing dir → `tools.dir.missing`) */
export async function loadToolsDir(dir: string, options: { locale?: Locale } = {}): Promise<LoadedTool[]> {
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new SchemaError('tools.dir.missing', { dir }, options.locale);
  }

  const files: string[] = [];
  await collectToolFiles(dir, files);

  const tools: LoadedTool[] = [];
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(file).href);
    const raw = (mod as { default?: unknown }).default;
    if (raw === undefined) {
      throw invalid(`"${file}" has no default export`, options.locale);
    }
    tools.push({ path: file, definition: validateToolDefinition(raw, options.locale) });
  }
  return tools;
}

import type { Pool } from 'pg';
import type { Locale, ObjectRegistry, ToolJsonSchema } from '../../core/index.js';
import type { ObjectDataAccess } from '../../runtime/data-access/index.js';
import type { McpSession } from './session.js';
import type { McpGuardrails } from './guardrails.js';
import type { IdentityResolver } from '../../core/provider/identity/index.js';

/**
 * Shared types for the MCP adapter (`src/adapters/mcp`). The adapter depends on
 * core contracts + the data-access type contract only; infrastructure/subsystem
 * implementations are injected by the assembly layer (createEngine).
 */

/** minimal JSON Schema subset the tool surface needs — shared with core/tools (single source) */
export type { ToolJsonSchema as JsonSchema } from '../../core/index.js';

/** the engine surface MCP tools operate through (data-access + registry + pool) */
export interface McpEngine {
  registry: ObjectRegistry;
  pool: Pool;
  dataAccess: ObjectDataAccess;
  locale: Locale;
}

/** everything one tool-call handler needs at execution time */
export interface ToolExecContext {
  engine: McpEngine;
  session: McpSession;
  guardrails: McpGuardrails;
  resolveIdentity: IdentityResolver;
}

/** a compiled MCP tool (per-session; the surface is filtered by RBAC) */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  handler(args: Record<string, unknown>, ctx: ToolExecContext): Promise<McpToolResult>;
}

/** the tool-call result envelope exposed to generate/tools/http */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** registry tool names / introspection names — single source in core/tools */
export { INTROSPECTION_TOOLS, REGISTRY_TOOLS } from '../../core/index.js';
export type { RegistryTool } from '../../core/index.js';

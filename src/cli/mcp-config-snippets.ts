/**
 * Ready-to-paste MCP client configuration for a WeaveKit `/mcp` endpoint.
 * Pure (no I/O) so it is unit-testable and reused by `weave mcp:config`.
 *
 * Host specifics (verified 2026-09):
 * - Claude Code: `claude mcp add --transport http <name> <url> --header "K: v"`
 * - Claude Desktop / Cursor: `{"mcpServers": { "<name>": { type:"http", url, headers } }}`
 * - VS Code: `{"servers": { "<name>": { type:"http", url, headers } }}` (note the `servers` key)
 * - stdio-only hosts: bridge via `npx mcp-remote <url> --header "K: v"`
 */

export const MCP_HOSTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'stdio', 'curl'] as const;
export type McpHost = (typeof MCP_HOSTS)[number];

export interface McpConfigInput {
  /** full MCP endpoint URL (e.g. http://localhost:3000/mcp) */
  url: string;
  /** agent-level API key (Authorization: Bearer) */
  key: string;
  /** on-behalf-of ref (X-Weavekit-On-Behalf-Of) */
  identity: string;
}

export interface McpConfigSnippets {
  'claude-code': string;
  'claude-desktop': string;
  cursor: string;
  vscode: string;
  stdio: string;
  curl: string;
}

/** build the JSON headers block shared by every config-file host */
function headers(input: McpConfigInput): Record<string, string> {
  return {
    Authorization: `Bearer ${input.key}`,
    'X-Weavekit-On-Behalf-Of': input.identity,
  };
}

/** ready-to-paste configuration for each supported MCP host */
export function mcpConfigSnippets(input: McpConfigInput): McpConfigSnippets {
  const mcpServers = {
    weavekit: { type: 'http', url: input.url, headers: headers(input) },
  };

  return {
    'claude-code': [
      'claude mcp add --transport http weavekit ' + input.url,
      `  --header "Authorization: Bearer ${input.key}"`,
      `  --header "X-Weavekit-On-Behalf-Of: ${input.identity}"`,
    ].join(' \\\n'),

    'claude-desktop': JSON.stringify({ mcpServers }, null, 2),

    cursor: JSON.stringify({ mcpServers }, null, 2),

    vscode: JSON.stringify({ servers: mcpServers }, null, 2),

    stdio: [
      'npx -y mcp-remote ' + input.url,
      `  --header "Authorization: Bearer ${input.key}"`,
      `  --header "X-Weavekit-On-Behalf-Of: ${input.identity}"`,
    ].join(' \\\n'),

    curl: [
      `curl -s -X POST ${input.url}`,
      `  -H 'content-type: application/json'`,
      `  -H 'accept: application/json, text/event-stream'`,
      `  -H 'authorization: Bearer ${input.key}'`,
      `  -H 'x-weavekit-on-behalf-of: ${input.identity}'`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'`,
    ].join(' \\\n'),
  };
}

/** file each config-file snippet belongs in (for CLI labels) */
export const MCP_HOST_FILES: Record<Exclude<McpHost, 'claude-code' | 'stdio' | 'curl'>, string> = {
  'claude-desktop': 'claude_desktop_config.json',
  cursor: '.cursor/mcp.json',
  vscode: '.vscode/mcp.json',
};

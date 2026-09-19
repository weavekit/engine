import kleur from 'kleur';
import { loadConfig } from '../load-config.js';
import { firstStaticKey } from '../facts.js';
import { MCP_HOSTS, MCP_HOST_FILES, mcpConfigSnippets, type McpHost } from '../mcp-config-snippets.js';
import type { McpConfigOptions } from '../types/index.js';

const HOST_SET = new Set<string>(MCP_HOSTS);

/**
 * `weave mcp:config` — print ready-to-paste configuration to connect an MCP
 * host (Claude Code / Claude Desktop / Cursor / VS Code / stdio bridge / curl)
 * to this project's `/mcp` endpoint, using the project's own endpoint, first
 * static API key and first on-behalf-of identity.
 */
export async function mcpConfig(cwd: string, options: McpConfigOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const endpoint = config.adapters?.mcp?.endpoint ?? '/mcp';
  const url = options.url ?? `http://localhost:${options.port ?? 3000}${endpoint}`;
  const key = options.key ?? firstStaticKey(config.auth?.source) ?? 'sk-admin';
  const identity = options.identity ?? firstStaticKey(config.adapters?.mcp?.identities) ?? 'alice';

  if (options.host !== undefined && !HOST_SET.has(options.host)) {
    p.error(`unknown --host "${options.host}" (expected: ${MCP_HOSTS.join(', ')})`);
    process.exitCode = 1;
    return;
  }

  const snippets = mcpConfigSnippets({ url, key, identity });
  const hosts: McpHost[] = options.host === undefined ? [...MCP_HOSTS] : [options.host as McpHost];

  if (p.json) {
    const payload: Partial<Record<McpHost, string>> = {};
    for (const host of hosts) payload[host] = snippets[host];
    p.data({ url, key, identity, snippets: payload });
    return;
  }

  p.log(`${kleur.bold('MCP endpoint')}  ${kleur.cyan(url)}`);
  p.log(`${kleur.dim('identity')}      ${identity}    ${kleur.dim('key')}  Bearer ${key}`);
  p.log('');
  for (const host of hosts) {
    const file = host in MCP_HOST_FILES ? kleur.dim(`  (${MCP_HOST_FILES[host as keyof typeof MCP_HOST_FILES]})`) : '';
    p.log(kleur.bold(host) + file);
    for (const line of snippets[host].split('\n')) p.log(`  ${line}`);
    p.log('');
  }
  p.log(kleur.dim('Guide: docs/practices/connect-agent.md'));
}

import { describe, it, expect } from '../helpers/test.js';
import {
  MCP_HOSTS,
  MCP_HOST_FILES,
  mcpConfigSnippets,
} from '../../src/cli/mcp-config-snippets.js';

const input = { url: 'http://localhost:3000/mcp', key: 'sk-admin', identity: 'alice' };

describe('mcpConfigSnippets — weave mcp:config', () => {
  const s = mcpConfigSnippets(input);

  it('claude-code uses `claude mcp add` with both headers', () => {
    expect(s['claude-code']).toContain('claude mcp add --transport http weavekit http://localhost:3000/mcp');
    expect(s['claude-code']).toContain('Authorization: Bearer sk-admin');
    expect(s['claude-code']).toContain('X-Weavekit-On-Behalf-Of: alice');
  });

  it('claude-desktop/cursor use `mcpServers`; vscode uses `servers`', () => {
    for (const host of ['claude-desktop', 'cursor'] as const) {
      const obj = JSON.parse(s[host]) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(obj)).toEqual(['mcpServers']);
      expect(obj.mcpServers.weavekit).toMatchObject({ type: 'http', url: input.url });
    }
    const vscode = JSON.parse(s.vscode) as { servers: Record<string, unknown> };
    expect(Object.keys(vscode)).toEqual(['servers']);
    expect(vscode.servers.weavekit).toMatchObject({ type: 'http', url: input.url });
  });

  it('json hosts carry both headers verbatim', () => {
    const obj = JSON.parse(s['claude-desktop']) as {
      mcpServers: { weavekit: { headers: Record<string, string> } };
    };
    expect(obj.mcpServers.weavekit.headers.Authorization).toBe('Bearer sk-admin');
    expect(obj.mcpServers.weavekit.headers['X-Weavekit-On-Behalf-Of']).toBe('alice');
  });

  it('stdio bridge and curl include the endpoint + headers', () => {
    expect(s.stdio).toContain('mcp-remote http://localhost:3000/mcp');
    expect(s.stdio).toContain('Bearer sk-admin');
    expect(s.curl).toContain('x-weavekit-on-behalf-of: alice');
    expect(s.curl).toContain('"method":"initialize"');
  });

  it('covers every declared host and labels config files', () => {
    for (const host of MCP_HOSTS) expect(typeof s[host]).toBe('string');
    expect(Object.values(MCP_HOST_FILES)).toEqual([
      'claude_desktop_config.json',
      '.cursor/mcp.json',
      '.vscode/mcp.json',
    ]);
  });
});

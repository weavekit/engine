import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, after } from '../helpers/test.js';
import { loadToolsDir, validateToolDefinition } from '../../src/runtime/tools/index.js';
import { INTROSPECTION_TOOLS, TOOL_PREFIXES, isReservedToolName } from '../../src/core/index.js';

const cleanups: string[] = [];
after(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weavekit-tools-'));
  cleanups.push(dir);
  return dir;
}

const validTool = {
  name: 'reassign_ticket',
  description: 'Transfer a ticket to another agent',
  inputSchema: {
    type: 'object',
    properties: { ticket_id: { type: 'string' }, to_agent: { type: 'string' } },
    required: ['ticket_id', 'to_agent'],
  },
  handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};

describe('validateToolDefinition — structural validation matrix', () => {
  it('valid definition passes', () => {
    expect(validateToolDefinition(validTool).name).toBe('reassign_ticket');
  });

  it('missing handler errors', () => {
    expect(() => validateToolDefinition({ ...validTool, handler: undefined })).toThrow(/handler/);
  });

  it('invalid name errors', () => {
    expect(() => validateToolDefinition({ ...validTool, name: 'Bad Name' })).toThrow(/must match/);
  });

  it('reserved prefix (generated tools) errors', () => {
    for (const prefix of Object.values(TOOL_PREFIXES)) {
      expect(() => validateToolDefinition({ ...validTool, name: `${prefix}lead` })).toThrow(/reserved/);
    }
  });

  it('reserved name (introspection tools) errors', () => {
    for (const name of Object.values(INTROSPECTION_TOOLS)) {
      expect(() => validateToolDefinition({ ...validTool, name })).toThrow(/reserved/);
    }
  });

  it('mcp. audit namespace errors', () => {
    expect(() => validateToolDefinition({ ...validTool, name: 'mcp.reassign' })).toThrow(/reserved/);
  });

  it('invalid inputSchema errors', () => {
    expect(() => validateToolDefinition({ ...validTool, inputSchema: [] })).toThrow(/inputSchema/);
    expect(() => validateToolDefinition({ ...validTool, inputSchema: 'x' })).toThrow(/inputSchema/);
    expect(() => validateToolDefinition({ ...validTool, inputSchema: undefined })).toThrow(/inputSchema/);
  });

  it('roles not a string array errors', () => {
    expect(() => validateToolDefinition({ ...validTool, roles: ['agent', 42] })).toThrow(/roles/);
  });

  it('non-object export errors', () => {
    expect(() => validateToolDefinition(null)).toThrow(/invalid tool definition/);
    expect(() => validateToolDefinition(42)).toThrow(/invalid tool definition/);
  });
});

describe('isReservedToolName — single source of truth', () => {
  it('generated/introspection/mcp namespaces all reserved', () => {
    expect(isReservedToolName('search_lead')).toBe(true);
    expect(isReservedToolName('get_lead')).toBe(true);
    expect(isReservedToolName('create_lead')).toBe(true);
    expect(isReservedToolName('update_lead')).toBe(true);
    expect(isReservedToolName('delete_lead')).toBe(true);
    expect(isReservedToolName('list_objects')).toBe(true);
    expect(isReservedToolName('describe_object')).toBe(true);
    expect(isReservedToolName('mcp.foo')).toBe(true);
    expect(isReservedToolName('reassign_ticket')).toBe(false);
    expect(isReservedToolName('close_ticket')).toBe(false);
  });
});

describe('loadToolsDir — directory loading', () => {
  it('missing directory throws tools.dir.missing', async () => {
    const dir = await tempDir();
    await expect(loadToolsDir(join(dir, 'nope'))).rejects.toThrow(/not found/);
  });

  it('empty directory returns empty array', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'tools'));
    const loaded = await loadToolsDir(join(dir, 'tools'));
    expect(loaded).toEqual([]);
  });

  it('loads valid tool module (default export + structural validation)', async () => {
    const dir = await tempDir();
    const toolsDir = join(dir, 'tools');
    await mkdir(toolsDir);
    await writeFile(
      join(toolsDir, 'reassign_ticket.js'),
      [
        'export default {',
        "  name: 'reassign_ticket',",
        "  description: 'Transfer a ticket',",
        "  inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' } } },",
        "  roles: ['agent', 'admin'],",
        "  handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
        '};',
      ].join('\n'),
    );
    const loaded = await loadToolsDir(toolsDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.definition.name).toBe('reassign_ticket');
    expect(loaded[0]!.definition.roles).toEqual(['agent', 'admin']);
    expect(loaded[0]!.definition.inputSchema).toMatchObject({ type: 'object' });
  });

  it('invalid module definition → startup error', async () => {
    const dir = await tempDir();
    const toolsDir = join(dir, 'tools');
    await mkdir(toolsDir);
    await writeFile(
      join(toolsDir, 'bad.js'),
      "export default { name: 'Bad Name', description: 'x', inputSchema: {}, handler: async () => {} };",
    );
    await expect(loadToolsDir(toolsDir)).rejects.toThrow(/must match/);
  });

  it('no default export → error', async () => {
    const dir = await tempDir();
    const toolsDir = join(dir, 'tools');
    await mkdir(toolsDir);
    await writeFile(join(toolsDir, 'noop.js'), 'export const x = 1;\n');
    await expect(loadToolsDir(toolsDir)).rejects.toThrow(/invalid tool definition/);
  });
});

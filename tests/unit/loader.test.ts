import { describe, it, expect } from '../helpers/test.js';import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaError } from '../../src/core/index.js';
import { loadSchemaDir } from '../../src/runtime/git/index.js';

const LEAD = JSON.stringify({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string' },
  ],
});

const LEAD_WF = JSON.stringify({
  name: 'lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'status', type: 'enum', options: ['draft', 'approved'] },
  ],
});

const LEAD_WORKFLOW = JSON.stringify({
  initial: 'draft',
  stateField: 'status',
  states: [{ name: 'draft' }, { name: 'approved' }],
  transitions: [{ action: 'approve', from: 'draft', to: 'approved' }],
});

async function withProjectDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'weavekit-loader-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function codeOf(error: unknown): string {
  return error instanceof SchemaError ? error.code : error instanceof Error ? error.message : String(error);
}

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('loadSchemaDir — objects/<name>/schema.json directory layout', () => {
  it('loads a single object (parent dir name = object name)', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'schema.json'), LEAD);
      const { registry, files } = await loadSchemaDir(root);
      expect(registry.list().map((d) => d.name)).toEqual(['lead']);
      expect(files).toHaveLength(1);
      const file = files[0]!;
      expect(file.name).toBe('lead');
      expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(file.object.fields).toHaveLength(2);
    });
  });

  it('supports nested subdirectories (nameHint = parent dir name)', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'crm', 'customer'), { recursive: true });
      await writeFile(join(root, 'objects', 'crm', 'customer', 'schema.json'), LEAD.replace('"lead"', '"customer"'));
      const { registry } = await loadSchemaDir(root);
      expect(registry.list().map((d) => d.name)).toEqual(['customer']);
    });
  });

  it('loads a sibling workflow.json and ignores other files', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'schema.json'), LEAD_WF);
      await writeFile(join(root, 'objects', 'lead', 'workflow.json'), LEAD_WORKFLOW);
      await writeFile(join(root, 'objects', 'lead', 'script.ts'), 'export const x = 1;');
      const { files } = await loadSchemaDir(root);
      expect(files).toHaveLength(1);
      expect(files[0]!.name).toBe('lead');
      expect(files[0]!.object.workflow?.stateField).toBe('status');
      expect(files[0]!.object.workflow?.transitions).toHaveLength(1);
    });
  });

  it('invalid workflow.json → parse.json.invalid', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'schema.json'), LEAD_WF);
      await writeFile(join(root, 'objects', 'lead', 'workflow.json'), '{ bad json');
      expect(codeOf(await thrownBy(() => loadSchemaDir(root)))).toBe('parse.json.invalid');
    });
  });

  it('flat leftover objects/lead.schema.json ignored (unified directory layout)', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead.schema.json'), LEAD);
      const { files } = await loadSchemaDir(root);
      expect(files).toHaveLength(0);
    });
  });

  it('dir name ≠ object name → object.nameHint.mismatch', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'wrong'), { recursive: true });
      await writeFile(join(root, 'objects', 'wrong', 'schema.json'), LEAD);
      expect(codeOf(await thrownBy(() => loadSchemaDir(root)))).toBe('object.nameHint.mismatch');
    });
  });

  it('missing objects/ directory → loader.dir.missing', async () => {
    await withProjectDir(async (root) => {
      expect(codeOf(await thrownBy(() => loadSchemaDir(root)))).toBe('loader.dir.missing');
    });
  });

  it('invalid JSON → parse.json.invalid', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'schema.json'), '{ bad json');
      expect(codeOf(await thrownBy(() => loadSchemaDir(root)))).toBe('parse.json.invalid');
    });
  });

  it('two directories define same-named object → registry.duplicate', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await mkdir(join(root, 'objects', 'other', 'lead'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'schema.json'), LEAD);
      await writeFile(join(root, 'objects', 'other', 'lead', 'schema.json'), LEAD);
      expect(codeOf(await thrownBy(() => loadSchemaDir(root)))).toBe('registry.duplicate');
    });
  });
});

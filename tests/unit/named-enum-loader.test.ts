import { describe, it, expect } from '../helpers/test.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaError } from '../../src/core/index.js';
import { loadEnumsDir, resolveEnumRegistry } from '../../src/runtime/enums/index.js';
import { loadSchemaDir } from '../../src/runtime/git/index.js';

const STATUS = { name: 'invoice_status', values: ['open', 'paid'], labels: { en: { open: 'Open', paid: 'Paid' } } };

async function withDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'weavekit-enums-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeEnum(root: string, fileName: string, value: unknown): Promise<void> {
  await mkdir(join(root, 'enums'), { recursive: true });
  await writeFile(join(root, 'enums', fileName), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('named enum loader — enums/*.json', () => {
  it('loads and validates declarations', async () => {
    await withDir(async (root) => {
      await writeEnum(root, 'invoice_status.json', STATUS);
      const loaded = await loadEnumsDir(join(root, 'enums'));
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.definition.name).toBe('invoice_status');
      expect(loaded[0]!.definition.labels?.en?.open).toBe('Open');
    });
  });

  it('a missing directory yields an empty list', async () => {
    await withDir(async (root) => {
      expect(await loadEnumsDir(join(root, 'enums'))).toEqual([]);
    });
  });

  it('rejects a file whose name does not match the declared name', async () => {
    await withDir(async (root) => {
      await writeEnum(root, 'wrong_name.json', STATUS);
      let threw: unknown;
      try {
        await loadEnumsDir(join(root, 'enums'));
      } catch (error) {
        threw = error;
      }
      expect(threw instanceof SchemaError).toBe(true);
      expect((threw as SchemaError).code).toBe('enum.invalid');
    });
  });

  it('rejects invalid JSON', async () => {
    await withDir(async (root) => {
      await writeEnum(root, 'oops.json', '{ not json');
      let threw: unknown;
      try {
        await loadEnumsDir(join(root, 'enums'));
      } catch (error) {
        threw = error;
      }
      expect((threw as SchemaError).code).toBe('enum.invalid');
    });
  });

  it('resolveEnumRegistry builds a lookup (missing dir → empty)', async () => {
    await withDir(async (root) => {
      await writeEnum(root, 'invoice_status.json', STATUS);
      const registry = await resolveEnumRegistry({ dir: join(root, 'enums') });
      expect(registry.has('invoice_status')).toBe(true);
      expect(registry.get('invoice_status')?.values).toEqual(['open', 'paid']);
      expect(registry.get('nope')).toBeUndefined();
      expect((await resolveEnumRegistry({ dir: join(root, 'absent') })).has('invoice_status')).toBe(false);
    });
  });
});

describe('loadSchemaDir — named enum auto-discovery', () => {
  it('loads <dir>/enums and resolves field references', async () => {
    await withDir(async (root) => {
      await writeEnum(root, 'invoice_status.json', STATUS);
      await mkdir(join(root, 'objects', 'invoice'), { recursive: true });
      await writeFile(
        join(root, 'objects', 'invoice', 'schema.json'),
        JSON.stringify({
          name: 'invoice',
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'status', type: 'enum', enumType: 'invoice_status' },
          ],
        }),
      );
      const { registry } = await loadSchemaDir(root);
      expect(registry.enums.has('invoice_status')).toBe(true);
      const status = registry.get('invoice')!.fields.find((f) => (f as { name: string }).name === 'status') as {
        options?: unknown;
      };
      expect(status.options).toEqual(['open', 'paid']);
    });
  });

  it('no enums directory → empty registry (unchanged behavior)', async () => {
    await withDir(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(
        join(root, 'objects', 'lead', 'schema.json'),
        JSON.stringify({
          name: 'lead',
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 's', type: 'enum', options: ['a'] },
          ],
        }),
      );
      const { registry } = await loadSchemaDir(root);
      expect(registry.enums.list()).toEqual([]);
    });
  });
});

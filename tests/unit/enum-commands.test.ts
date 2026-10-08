import { describe, it, expect } from '../helpers/test.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumCheck, enumList } from '../../src/cli/commands/enums.js';
import { fieldAdd } from '../../src/cli/commands/field-add.js';
import type { CliPrinter } from '../../src/cli/render.js';

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, () => resolve());
  });
}

interface Capture {
  printer: CliPrinter;
  lines: string[];
  errors: string[];
  tables: string[][][];
}

function capturingPrinter(): Capture {
  const lines: string[] = [];
  const errors: string[] = [];
  const tables: string[][][] = [];
  return {
    printer: {
      json: true,
      kv() {},
      table(rows) {
        tables.push(rows);
      },
      data() {},
      log(message) {
        lines.push(message);
      },
      error(message) {
        errors.push(message);
      },
    },
    lines,
    errors,
    tables,
  };
}

const STATUS = { name: 'invoice_status', values: ['open', 'paid'], labels: { en: { open: 'Open', paid: 'Paid' } } };

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wk-enum-cmd-'));
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(root, 'enums'), { recursive: true });
  await mkdir(join(root, 'objects', 'invoice'), { recursive: true });
  await writeFile(join(root, 'enums', 'invoice_status.json'), `${JSON.stringify(STATUS, null, 2)}\n`);
  await writeFile(join(root, 'weavekit.config.ts'), "export default { schemaDir: '.' };\n");
  return root;
}

async function writeSchema(root: string, field: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(root, 'objects', 'invoice', 'schema.json'),
    `${JSON.stringify({ schemaVersion: 2, name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, field] }, null, 2)}\n`,
  );
}

async function withProject(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await makeProject();
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn(root);
  } finally {
    process.exitCode = previous;
    await rm(root, { recursive: true, force: true });
  }
}

describe('weave enum:list', () => {
  it('lists declarations with values, label locales and source', async () => {
    await withProject(async (root) => {
      const capture = capturingPrinter();
      await enumList(root, { printer: capture.printer });
      const rows = capture.tables[0]!;
      const row = rows.find((r) => r[0] === 'invoice_status');
      expect(row?.[1]).toBe('open, paid');
      expect(row?.[2]).toBe('en');
      expect(row?.[3]).toBe('enums/invoice_status.json');
    });
  });
});

describe('weave enum:check', () => {
  it('passes when schema references resolve', async () => {
    await withProject(async (root) => {
      await writeSchema(root, { name: 'status', type: 'enum', enumType: 'invoice_status' });
      const capture = capturingPrinter();
      await enumCheck(root, { printer: capture.printer });
      expect(capture.errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it('fails when a schema references an unknown enum', async () => {
    await withProject(async (root) => {
      await writeSchema(root, { name: 'status', type: 'enum', enumType: 'missing_status' });
      const capture = capturingPrinter();
      await enumCheck(root, { printer: capture.printer });
      expect(capture.errors.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    });
  });

  it('fails when a declaration is invalid', async () => {
    await withProject(async (root) => {
      await writeFile(join(root, 'enums', 'broken.json'), '{ not json');
      await writeSchema(root, { name: 'status', type: 'enum', enumType: 'invoice_status' });
      const capture = capturingPrinter();
      await enumCheck(root, { printer: capture.printer });
      expect(capture.errors.some((e) => e.startsWith('declarations:'))).toBe(true);
      expect(process.exitCode).toBe(1);
    });
  });
});

describe('weave field:add --enum', () => {
  it('writes an enumType reference (no inline options)', async () => {
    await withProject(async (root) => {
      await writeSchema(root, { name: 'memo', type: 'string' });
      const capture = capturingPrinter();
      await fieldAdd(root, 'invoice', { name: 'status', type: 'enum', enum: 'invoice_status', printer: capture.printer });
      expect(capture.errors).toEqual([]);
      const schema = JSON.parse(await readFile(join(root, 'objects', 'invoice', 'schema.json'), 'utf8')) as {
        fields: Record<string, unknown>[];
      };
      const status = schema.fields.find((f) => f.name === 'status')!;
      expect(status.enumType).toBe('invoice_status');
      expect(status.options).toBeUndefined();
    });
  });

  it('rejects an unknown enum reference', async () => {
    await withProject(async (root) => {
      await writeSchema(root, { name: 'memo', type: 'string' });
      const capture = capturingPrinter();
      await fieldAdd(root, 'invoice', { name: 'status', type: 'enum', enum: 'nope', printer: capture.printer });
      expect(process.exitCode).toBe(1);
      expect(capture.errors.some((e) => e.includes('invalid schema'))).toBe(true);
    });
  });
});

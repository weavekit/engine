import { describe, it, expect } from '../helpers/test.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldTypeCheck, fieldTypeList } from '../../src/cli/commands/field-types.js';
import type { CliPrinter } from '../../src/cli/render.js';

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

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wk-field-types-'));
  await mkdir(join(root, 'field-types'), { recursive: true });
  await mkdir(join(root, 'objects', 'invoice'), { recursive: true });
  await writeFile(
    join(root, 'field-types', 'acme.ts'),
    "export default { namespace: 'acme', name: 'money', base: 'number' };\n",
  );
  await writeFile(
    join(root, 'weavekit.config.ts'),
    "export default { schemaDir: '.', fieldTypes: { dir: 'field-types' }, features: { fieldTypes: ['string', 'acme_money'] } };\n",
  );
  return root;
}

async function writeSchema(root: string, type: string): Promise<void> {
  await writeFile(
    join(root, 'objects', 'invoice', 'schema.json'),
    `${JSON.stringify(
      { schemaVersion: 2, name: 'invoice', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'amount', type }] },
      null,
      2,
    )}\n`,
  );
}

describe('weave field-type:list', () => {
  it('lists built-ins and project registrations with source + base', async () => {
    const root = await makeProject();
    try {
      const capture = capturingPrinter();
      await fieldTypeList(root, { printer: capture.printer });
      const rows = capture.tables[0]!;
      expect(rows.some((r) => r[0] === 'currency' && r[1] === 'builtin')).toBe(true);
      const registered = rows.find((r) => r[0] === 'acme_money');
      expect(registered?.[1]).toBe('field-types/acme.ts');
      expect(registered?.[2]).toBe('number');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('weave field-type:check', () => {
  it('passes on a valid project (schema uses a registered type)', async () => {
    const root = await makeProject();
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeSchema(root, 'acme_money');
      const capture = capturingPrinter();
      await fieldTypeCheck(root, { printer: capture.printer });
      expect(capture.errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when a schema uses an unregistered type', async () => {
    const root = await makeProject();
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeSchema(root, 'acme_unknown');
      const capture = capturingPrinter();
      await fieldTypeCheck(root, { printer: capture.printer });
      expect(capture.errors.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when features.fieldTypes names an unknown type', async () => {
    const root = await makeProject();
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await writeFile(
        join(root, 'weavekit.config.ts'),
        "export default { schemaDir: '.', fieldTypes: { dir: 'field-types' }, features: { fieldTypes: ['string', 'acme_money', 'ghost_type'] } };\n",
      );
      await writeSchema(root, 'acme_money');
      const capture = capturingPrinter();
      await fieldTypeCheck(root, { printer: capture.printer });
      expect(capture.errors.some((e) => e.includes('ghost_type'))).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

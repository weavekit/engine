import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, after, before } from '../helpers/test.js';import { SCRIPT_HOOKS, SchemaError } from '../../src/core/index.js';
import { loadScriptDir } from '../../src/subsystems/script/loader.js';

let root: string;
let objectsDir: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wk-loader-'));
  objectsDir = join(root, 'objects');
  await mkdir(join(objectsDir, 'lead'), { recursive: true });
  await mkdir(join(objectsDir, 'supplier'), { recursive: true });
  await writeFile(
    join(objectsDir, 'lead', 'server.js'),
    `// server script
export function validate() { if (this.changes.amount <= 0) throw new Error('bad'); }
export async function beforeUpdate() { this.changes.approved = true; return this.changes; }
export const helper = 42; // not a hook
`,
  );
  await writeFile(join(objectsDir, 'lead', 'client.js'), 'export function onLoad() {}');
  await writeFile(join(objectsDir, 'lead', 'schema.json'), '{}');
  await writeFile(
    join(objectsDir, 'supplier', 'server.js'),
    `export function afterDelete() { this.db.objects('lead').delete(this.record.id); }`,
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadScriptDir — file discovery and hook detection', () => {
  it('discovers only server.js, ignores client.js and schema.json', async () => {
    const scripts = await loadScriptDir(objectsDir);
    expect(scripts.map((s) => s.name).sort()).toEqual(['lead', 'supplier']);
    expect(scripts.every((s) => s.path.endsWith('server.js'))).toBe(true);
  });

  it('detects hooks by exported function name, ignores helper and unknown exports', async () => {
    const lead = (await loadScriptDir(objectsDir)).find((s) => s.name === 'lead')!;
    expect([...lead.hooks].sort()).toEqual([SCRIPT_HOOKS.BEFORE_UPDATE, SCRIPT_HOOKS.VALIDATE]);
  });

  it('supplier detects afterDelete', async () => {
    const supplier = (await loadScriptDir(objectsDir)).find((s) => s.name === 'supplier')!;
    expect(supplier.hooks).toEqual([SCRIPT_HOOKS.AFTER_DELETE]);
  });

  it('objects directory missing → loader.dir.missing', async () => {
    try {
      await loadScriptDir(join(root, 'nope'));
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as SchemaError).code).toBe('loader.dir.missing');
    }
  });
});

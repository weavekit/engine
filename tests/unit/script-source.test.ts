import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry, SCRIPT_SOURCE_KINDS, SchemaError } from '../../src/core/index.js';
import { readScriptSource, validateScriptSource, writeScriptSource } from '../../src/runtime/git/scriptSource.js';
import { describe, expect, it } from '../helpers/test.js';

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (_error, stdout) => resolve({ stdout }));
  });
}

function registry(): ObjectRegistry {
  const value = new ObjectRegistry();
  value.register({ name: 'lead', fields: [{ name: 'id', type: 'string', primary: true }] });
  value.buildGraph();
  return value;
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wk-script-source-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(join(root, 'objects', 'lead'), { recursive: true });
    await writeFile(join(root, 'objects', 'lead', 'schema.json'), '{}');
    await git(root, ['add', 'objects/lead/schema.json']);
    await git(root, ['commit', '-m', 'initial']);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('script source store', () => {
  it('validates JavaScript and parameterless server hooks', async () => {
    await validateScriptSource('export function validate() {}', SCRIPT_SOURCE_KINDS.SERVER);
    for (const source of [
      'export function validate(unknown) {}',
      'export const validate = async unknown => true;',
      'export const validate = 1;',
      'export const broken = ;',
    ]) {
      let thrown: unknown;
      try {
        await validateScriptSource(source, SCRIPT_SOURCE_KINDS.SERVER);
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof SchemaError).toBe(true);
      expect((thrown as SchemaError).code).toBe('http.param.invalid');
    }
  });

  it('writes, versions, and commits only the requested script path', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'README.md'), 'staged elsewhere');
      await git(root, ['add', 'README.md']);
      const result = await writeScriptSource({
        projectDir: root,
        registry: registry(),
        objectName: 'lead',
        kind: SCRIPT_SOURCE_KINDS.SHOW_CLIENT,
        source: 'export function onValidate() { return true; }\n',
      });
      expect(result.committed).toBe(true);
      expect(result.version).toMatch(/^[0-9a-f]{64}$/);
      expect((await readScriptSource(root, registry(), 'lead', SCRIPT_SOURCE_KINDS.SHOW_CLIENT))?.source).toBe(result.source);
      expect((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout.trim()).toBe('pages/lead/show.client.js');
      expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('README.md');
    });
  });

  it('returns committed false when source is unchanged', async () => {
    await withRepo(async (root) => {
      const input = {
        projectDir: root,
        registry: registry(),
        objectName: 'lead',
        kind: SCRIPT_SOURCE_KINDS.LIST_CLIENT,
        source: '',
      } as const;
      expect((await writeScriptSource(input)).committed).toBe(true);
      expect((await writeScriptSource(input)).committed).toBe(false);
    });
  });

  it('rejects unknown objects before resolving a file path', async () => {
    let thrown: unknown;
    try {
      await readScriptSource('.', registry(), '../outside', SCRIPT_SOURCE_KINDS.SERVER);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as SchemaError).code).toBe('data.objectUnknown');
  });

  it('restores an existing file when Git commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-script-source-no-git-'));
    try {
      const path = join(root, 'objects', 'lead', 'server.js');
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await writeFile(path, 'export function validate() {}\n');
      let thrown: unknown;
      try {
        await writeScriptSource({
          projectDir: root,
          registry: registry(),
          objectName: 'lead',
          kind: SCRIPT_SOURCE_KINDS.SERVER,
          source: 'export function beforeUpdate() {}\n',
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('git.notRepo');
      expect(await readFile(path, 'utf8')).toBe('export function validate() {}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaError } from '../../src/core/index.js';
import {
  commitPaths,
  deleteSourceFile,
  readSource,
  runSourceTransaction,
} from '../../src/runtime/git/index.js';
import { describe, expect, it } from '../helpers/test.js';

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (_error, stdout) => resolve({ stdout }));
  });
}

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wk-src-tx-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(join(root, 'pages'), { recursive: true });
    await writeFile(join(root, 'pages', 'a.layout.json'), '{"a":1}\n');
    await git(root, ['add', 'pages/a.layout.json']);
    await git(root, ['commit', '-m', 'initial']);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('source transaction', () => {
  it('commits multiple files as one unit and preserves unrelated staged changes', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'README.md'), 'staged elsewhere');
      await git(root, ['add', 'README.md']);
      const current = (await readSource(root, 'pages/a.layout.json'))!;

      const result = await runSourceTransaction({
        projectDir: root,
        files: [
          { path: 'pages/a.layout.json', source: '{"a":2}\n', expectVersion: current.version },
          { path: 'pages/b.layout.json', source: '{"b":1}\n' },
        ],
      });
      expect(result.committed).toBe(true);

      const files = (await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout.trim().split(/\s+/);
      expect(files.sort()).toEqual(['pages/a.layout.json', 'pages/b.layout.json']);
      // unrelated staged content stays staged, untouched
      expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('README.md');
    });
  });

  it('throws 409 versionMismatch on a stale expectVersion and leaves files untouched', async () => {
    await withRepo(async (root) => {
      const current = (await readSource(root, 'pages/a.layout.json'))!;
      let thrown: unknown;
      try {
        await runSourceTransaction({
          projectDir: root,
          files: [{ path: 'pages/a.layout.json', source: '{"a":9}\n', expectVersion: '0'.repeat(64) }],
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('source.versionMismatch');
      expect(await readFile(join(root, 'pages/a.layout.json'), 'utf8')).toBe('{"a":1}\n');
      expect(current.version).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('force bypasses the version check', async () => {
    await withRepo(async (root) => {
      const result = await runSourceTransaction({
        projectDir: root,
        force: true,
        files: [{ path: 'pages/a.layout.json', source: '{"a":9}\n', expectVersion: '0'.repeat(64) }],
      });
      expect(result.committed).toBe(true);
      expect(await readFile(join(root, 'pages/a.layout.json'), 'utf8')).toBe('{"a":9}\n');
    });
  });

  it('runs validation before any write — a failing validator leaves every file untouched', async () => {
    await withRepo(async (root) => {
      const current = (await readSource(root, 'pages/a.layout.json'))!;
      let thrown: unknown;
      try {
        await runSourceTransaction({
          projectDir: root,
          files: [
            { path: 'pages/a.layout.json', source: '{"a":2}\n', expectVersion: current.version },
            { path: 'pages/b.layout.json', source: '{"b":1}\n' },
          ],
          validate: () => {
            throw new SchemaError('layout.node.notAllowed', { type: 'x', profile: 'shell', path: 'p' });
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('layout.node.notAllowed');
      expect(await readFile(join(root, 'pages/a.layout.json'), 'utf8')).toBe('{"a":1}\n');
      // second file was never created
      let created = true;
      try {
        await readFile(join(root, 'pages/b.layout.json'), 'utf8');
      } catch {
        created = false;
      }
      expect(created).toBe(false);
    });
  });

  it('restores working-tree files when the Git commit fails', async () => {
    await withRepo(async (root) => {
      // untracked + gitignored target: `git add` fails after the file was replaced
      await writeFile(join(root, '.gitignore'), 'pages/ignored.layout.json\n');
      await writeFile(join(root, 'pages', 'ignored.layout.json'), '{"v":0}\n');
      const current = (await readSource(root, 'pages/ignored.layout.json'))!;
      let thrown: unknown;
      try {
        await runSourceTransaction({
          projectDir: root,
          files: [{ path: 'pages/ignored.layout.json', source: '{"v":1}\n', expectVersion: current.version }],
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('git.command.failed');
      expect(await readFile(join(root, 'pages', 'ignored.layout.json'), 'utf8')).toBe('{"v":0}\n');
    });
  });

  it('creates a new file and deletes a file via deleteSourceFile', async () => {
    await withRepo(async (root) => {
      const created = await runSourceTransaction({
        projectDir: root,
        files: [{ path: 'pages/new.layout.json', source: '{"n":1}\n' }],
      });
      expect(created.committed).toBe(true);

      const deleted = await deleteSourceFile({ projectDir: root, path: 'pages/new.layout.json' });
      expect(deleted.committed).toBe(true);
      expect(await readSource(root, 'pages/new.layout.json')).toBeNull();

      let thrown: unknown;
      try {
        await deleteSourceFile({ projectDir: root, path: 'pages/new.layout.json' });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('http.notFound');
    });
  });

  it('commitPaths leaves unrelated staged content intact', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'README.md'), 'staged elsewhere');
      await git(root, ['add', 'README.md']);
      await writeFile(join(root, 'pages', 'a.layout.json'), '{"a":3}\n');
      await writeFile(join(root, 'pages', 'b.layout.json'), '{"b":1}\n');
      await commitPaths({
        dir: root,
        paths: ['pages/a.layout.json', 'pages/b.layout.json'],
        message: 'test commit',
      });
      expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('README.md');
      const files = (await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout.trim().split(/\s+/);
      expect(files.sort()).toEqual(['pages/a.layout.json', 'pages/b.layout.json']);
    });
  });
});

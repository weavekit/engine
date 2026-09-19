import { describe, it, expect } from '../helpers/test.js';import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaError } from '../../src/core/index.js';
import { autoCommit } from '../../src/runtime/git/index.js';

const LEAD = JSON.stringify({
  name: 'lead',
  fields: [{ name: 'id', type: 'string', primary: true }],
});

interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : 1, stdout, stderr });
    });
  });
}

async function initRepo(root: string): Promise<void> {
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
}

async function writeObject(root: string, name: string): Promise<void> {
  await mkdir(join(root, 'objects', name), { recursive: true });
  await writeFile(join(root, 'objects', name, 'schema.json'), LEAD);
}

async function withRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'weavekit-git-'));
  try {
    await initRepo(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('autoCommit — metadata tree git add + commit', () => {
  it('changes present → committed=true + sha + commit visible', async () => {
    await withRepo(async (root) => {
      await writeObject(root, 'lead');
      const result = await autoCommit({ dir: root });
      expect(result.committed).toBe(true);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      const log = await git(root, ['log', '--oneline']);
      expect(log.stdout).toContain('chore(metadata): sync schema objects');
    });
  });

  it('no changes → committed=false', async () => {
    await withRepo(async (root) => {
      await writeObject(root, 'lead');
      await autoCommit({ dir: root });
      const second = await autoCommit({ dir: root });
      expect(second.committed).toBe(false);
    });
  });

  it('non-git directory → git.notRepo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-git-'));
    try {
      await writeObject(root, 'lead');
      let threw: unknown;
      try {
        await autoCommit({ dir: root });
      } catch (error) {
        threw = error;
      }
      expect(threw instanceof SchemaError).toBe(true);
      expect((threw as SchemaError).code).toBe('git.notRepo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('commit succeeds with fallback identity when repo has no identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-git-'));
    try {
      await git(root, ['init']);
      await writeObject(root, 'lead');
      const result = await autoCommit({ dir: root });
      expect(result.committed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('identity option overrides committer', async () => {
    await withRepo(async (root) => {
      await writeObject(root, 'lead');
      await autoCommit({ dir: root, identity: { name: 'Bot', email: 'bot@local' } });
      const author = await git(root, ['log', '-1', '--format=%an <%ae>']);
      expect(author.stdout).toContain('Bot <bot@local>');
    });
  });

  it('stages only the objects path, leaves other files untouched', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'README.md'), 'hello');
      await writeObject(root, 'lead');
      await autoCommit({ dir: root });
      const status = await git(root, ['status', '--porcelain']);
      expect(status.stdout.trim()).toBe('?? README.md');
    });
  });
});

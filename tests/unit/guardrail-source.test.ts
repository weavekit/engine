import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaError } from '../../src/core/index.js';
import {
  assertPolicyName,
  listGuardrailHistory,
  listGuardrailPolicies,
  readGuardrailPolicy,
  writeGuardrailPolicy,
} from '../../src/runtime/git/guardrailSource.js';
import { describe, expect, it } from '../helpers/test.js';

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (_error, stdout) => resolve({ stdout }));
  });
}

async function withRepo(extraPolicies = true, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wk-guardrail-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await mkdir(join(root, 'policies'), { recursive: true });
    if (extraPolicies) {
      await writeFile(join(root, 'policies', 'approve-grant.js'), 'export const policy = {};\n');
      await git(root, ['add', 'policies']);
      await git(root, ['commit', '-m', 'initial']);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('guardrail policy source', () => {
  it('validates policy names (no traversal / non-ext)', () => {
    for (const name of ['approve-grant.js', 'pii_mask.cjs', 'threshold.mjs']) {
      expect(() => assertPolicyName(name)).not.toThrow();
    }
    for (const name of ['../outside.js', 'a/b.js', '.hidden.js', 'policy.ts', '']) {
      let thrown: unknown;
      try {
        assertPolicyName(name);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('http.param.invalid');
    }
  });

  it('writes, versions, and commits only the requested policy path', async () => {
    await withRepo(false, async (root) => {
      await writeFile(join(root, 'README.md'), 'staged elsewhere');
      await git(root, ['add', 'README.md']);
      const result = await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', {
        source: 'export default { match: () => true };\n',
      });
      expect(result.committed).toBe(true);
      expect(result.version).toMatch(/^[0-9a-f]{64}$/);
      expect((await readGuardrailPolicy(root, 'policies', 'approve-grant.js'))?.source).toBe(result.source);
      expect((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout.trim()).toBe('policies/approve-grant.js');
      expect((await git(root, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('README.md');
    });
  });

  it('lists only policy files and reflects an update', async () => {
    await withRepo(true, async (root) => {
      await writeFile(join(root, 'policies', 'README.txt'), 'ignore me');
      await writeFile(join(root, 'policies', '.hidden.js'), 'not a policy');
      const before = await listGuardrailPolicies(root, 'policies');
      expect(before.map((p) => p.name)).toEqual(['approve-grant.js']);
      await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', {
        source: 'export default { match: () => false };\n',
      });
      const after = await listGuardrailPolicies(root, 'policies');
      expect(after).toHaveLength(1);
      expect(after[0]!.version).not.toBe(before[0]!.version);
    });
  });

  it('returns committed false when the source is unchanged', async () => {
    await withRepo(true, async (root) => {
      const input = { source: 'export default { match: () => true };\n' } as const;
      expect((await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', input)).committed).toBe(true);
      expect((await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', input)).committed).toBe(false);
    });
  });

  it('rejects invalid JavaScript', async () => {
    await withRepo(true, async (root) => {
      let thrown: unknown;
      try {
        await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', { source: 'export const broken = ;\n' });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('http.param.invalid');
    });
  });

  it('reads git history (newest first) with a source blob per commit', async () => {
    await withRepo(true, async (root) => {
      await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', {
        source: 'export default { match: () => false };\n',
      });
      const history = await listGuardrailHistory(root, 'policies', 'approve-grant.js');
      expect(history.name).toBe('approve-grant.js');
      expect(history.commits).toHaveLength(2);
      expect(history.commits[0]!.source).toBe('export default { match: () => false };\n');
      expect(history.commits[1]!.source).toBe('export const policy = {};\n');
      expect(history.commits[0]!.sha).not.toBe(history.commits[1]!.sha);
      expect(history.commits[0]!.message).toContain('update approve-grant.js');
      expect(history.commits[0]!.author).toBe('Test');
    });
  });

  it('returns an empty history outside a git work tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-guardrail-ng-'));
    try {
      await mkdir(join(root, 'policies'), { recursive: true });
      await writeFile(join(root, 'policies', 'approve-grant.js'), 'export default {};\n');
      const history = await listGuardrailHistory(root, 'policies', 'approve-grant.js');
      expect(history.commits).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores an existing policy when the Git commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wk-guardrail-no-git-'));
    try {
      await mkdir(join(root, 'policies'), { recursive: true });
      await writeFile(join(root, 'policies', 'approve-grant.js'), 'export default { match: () => true };\n');
      let thrown: unknown;
      try {
        await writeGuardrailPolicy(root, 'policies', 'approve-grant.js', {
          source: 'export default { match: () => false };\n',
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as SchemaError).code).toBe('git.notRepo');
      expect(await readFile(join(root, 'policies', 'approve-grant.js'), 'utf8')).toBe(
        'export default { match: () => true };\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from '../helpers/test.js';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSchemaDir } from '../../src/runtime/git/index.js';
import { buildCommitMessage, diffMetadata } from '../../src/runtime/git/schemaChange.js';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      else resolve(_stdout);
    });
  });
}

async function initRepo(root: string): Promise<void> {
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
}

async function writeObject(root: string, name: string, json: string): Promise<void> {
  await mkdir(join(root, 'objects', name), { recursive: true });
  await writeFile(join(root, 'objects', name, 'schema.json'), json);
}

describe('schemaChange — field-level diff + commit message', () => {
  it('diffMetadata: field add/remove, label/alter, permissions changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-schema-'));
    try {
      await initRepo(root);
      await writeObject(
        root,
        'products',
        JSON.stringify({
          name: 'products',
          labels: { en: 'Products' },
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'name', type: 'string', required: true },
            { name: 'price', type: 'currency', default: 0 },
          ],
          permissions: { admin: { read: 'all', create: true } },
        }),
      );
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      await writeObject(
        root,
        'products',
        JSON.stringify({
          name: 'products',
          labels: { en: 'Products v2' },
          alter: true,
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'price', type: 'currency', default: 0 },
            { name: 'price2', type: 'currency', default: 0 },
          ],
          permissions: { admin: { read: 'all', create: true, update: ['price'] } },
        }),
      );

      const { files } = await loadSchemaDir(root);
      const changes = await diffMetadata(root, files);
      expect(changes.some((c) => c.kind === 'field.added' && c.field === 'price2' && c.type === 'currency')).toBe(true);
      expect(changes.some((c) => c.kind === 'field.removed' && c.field === 'name' && c.type === 'string')).toBe(true);
      expect(changes.some((c) => c.kind === 'object.updated' && c.attr === 'alter' && c.after === true)).toBe(true);
      expect(changes.some((c) => c.kind === 'object.updated' && c.attr === 'labels')).toBe(true);
      expect(changes.some((c) => c.kind === 'permissions.changed' && c.role === 'admin')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('buildCommitMessage: subject + field lines + full old/new for permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-schema-'));
    try {
      await initRepo(root);
      await writeObject(
        root,
        'products',
        JSON.stringify({
          name: 'products',
          fields: [{ name: 'id', type: 'string', primary: true }],
          permissions: { admin: { read: 'all', create: true } },
        }),
      );
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      await writeObject(
        root,
        'products',
        JSON.stringify({
          name: 'products',
          fields: [
            { name: 'id', type: 'string', primary: true },
            { name: 'price2', type: 'currency', default: 0 },
          ],
          permissions: { admin: { read: 'all', create: true, update: ['price2'] } },
        }),
      );

      const { files } = await loadSchemaDir(root);
      const changes = await diffMetadata(root, files);
      const msg = buildCommitMessage(changes);
      expect(msg).toContain('chore(metadata): update schema (1 object)');
      expect(msg).toContain('+ price2 (currency, default 0)');
      expect(msg).toContain('permissions:');
      expect(msg).toContain('admin: {"read":"all","create":true} → {"read":"all","create":true,"update":["price2"]}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('diffMetadata: removed object → object.removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weavekit-schema-'));
    try {
      await initRepo(root);
      await writeObject(root, 'legacy', JSON.stringify({ name: 'legacy', fields: [{ name: 'id', type: 'string', primary: true }] }));
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);
      await rm(join(root, 'objects', 'legacy'), { recursive: true, force: true });

      const { files } = await loadSchemaDir(root);
      const changes = await diffMetadata(root, files);
      expect(changes.some((c) => c.kind === 'object.removed' && c.object === 'legacy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no changes → default message', async () => {
    expect(buildCommitMessage([])).toBe('chore(metadata): sync schema objects');
  });
});

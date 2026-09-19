import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../helpers/test.js';
import { migratePages } from '../../src/cli/commands/pages-migrate.js';

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (_error, stdout) => resolve({ stdout }));
  });
}

const noopPrinter = { json: false, kv() {}, table() {}, data() {}, log() {}, error() {} } as const;

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wk-pages-migrate-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('weave pages:migrate (forced custom-page directory migration)', () => {
  it('moves legacy flat custom pages into pages/<id>/layout.json and commits', async () => {
    await withRepo(async (root) => {
      await mkdir(join(root, 'pages'), { recursive: true });
      await writeFile(join(root, 'pages', 'dash.layout.json'), '{"viewports":{"desktop":{"mode":"vertical","layout":[]}}}\n');
      // shell stays flat
      await writeFile(join(root, 'pages', 'app.layout.json'), '{"viewports":{"desktop":{"mode":"vertical","layout":[]}}}\n');

      await migratePages(root, { printer: noopPrinter });

      expect(await readFile(join(root, 'pages', 'dash', 'layout.json'), 'utf8')).toContain('"viewports"');
      // legacy flat file is gone
      let flatGone = false;
      try {
        await readFile(join(root, 'pages', 'dash.layout.json'), 'utf8');
      } catch {
        flatGone = true;
      }
      expect(flatGone).toBe(true);
      // shell untouched
      expect(await readFile(join(root, 'pages', 'app.layout.json'), 'utf8')).toContain('"viewports"');
      // committed
      const show = await git(root, ['show', '--format=', '--name-only', 'HEAD']);
      expect(show.stdout).toContain('pages/dash/layout.json');
    });
  });

  it('skips flat pages whose id collides with an object page dir', async () => {
    await withRepo(async (root) => {
      await mkdir(join(root, 'pages', 'tickets'), { recursive: true });
      await writeFile(join(root, 'pages', 'tickets', 'show.layout.json'), '{"viewports":{}}\n');
      await writeFile(join(root, 'pages', 'tickets.layout.json'), '{"viewports":{}}\n');

      await migratePages(root, { printer: noopPrinter });

      // the colliding flat file is left in place (rejected by the layout reader)
      expect(await readFile(join(root, 'pages', 'tickets.layout.json'), 'utf8')).toContain('"viewports"');
      // nothing committed for it
      const show = await git(root, ['log', '--oneline']);
      expect(show.stdout.trim()).toBe('');
    });
  });

  it('relocates object client scripts into pages/<object>/ and drops stale page-level/block scripts', async () => {
    await withRepo(async (root) => {
      await mkdir(join(root, 'objects', 'lead'), { recursive: true });
      await mkdir(join(root, 'pages', 'lead'), { recursive: true });
      await mkdir(join(root, 'pages', 'dash'), { recursive: true });
      await mkdir(join(root, 'pages', 'dash', 'blocks'), { recursive: true });
      await writeFile(join(root, 'objects', 'lead', 'show.client.js'), 'export function onValidate() {}\n');
      await writeFile(join(root, 'objects', 'lead', 'list.client.js'), 'export function onRowAction() {}\n');
      await writeFile(join(root, 'objects', 'lead', 'server.js'), 'export function beforeUpdate() {}\n');
      // stale intermediate artifacts
      await writeFile(join(root, 'pages', 'dash', 'show.client.js'), 'export function onLoad() {}\n');
      await writeFile(join(root, 'pages', 'dash', 'blocks', 'b1.list.client.js'), 'export function onLoad() {}\n');
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-m', 'initial']);

      await migratePages(root, { printer: noopPrinter });

      // canonical client scripts now live beside the object's pages; server.js stays in objects/
      expect(await readFile(join(root, 'pages', 'lead', 'show.client.js'), 'utf8')).toContain('onValidate');
      expect(await readFile(join(root, 'pages', 'lead', 'list.client.js'), 'utf8')).toContain('onRowAction');
      expect(await readFile(join(root, 'objects', 'lead', 'server.js'), 'utf8')).toContain('beforeUpdate');
      expect((await readFile(join(root, 'objects', 'lead', 'show.client.js'), 'utf8').catch(() => '')).toString()).not.toContain('onValidate');
      // stale page-level + blocks scripts removed
      let staleGone = true;
      try {
        await readFile(join(root, 'pages', 'dash', 'show.client.js'), 'utf8');
        staleGone = false;
      } catch {
        /* removed */
      }
      expect(staleGone).toBe(true);
      expect((await git(root, ['show', '--format=', '--name-only', 'HEAD'])).stdout).toContain('pages/lead/show.client.js');
    });
  });
});
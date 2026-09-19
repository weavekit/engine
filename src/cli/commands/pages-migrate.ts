import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { commitPaths } from '../../runtime/git/autoCommit.js';
import { runGit } from '../../runtime/git/runner.js';
import type { CliPrinter } from '../render.js';

export interface MigratePagesOptions {
  printer: CliPrinter;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forced migration of custom pages to the directory layout (`pages/<id>.layout.json`
 * → `pages/<id>/layout.json`). The shell stays flat (`pages/app.layout.json`);
 * object page dirs (`pages/<id>/show|list.layout.json`) are left untouched and
 * any flat page whose id collides with an object dir is skipped with a warning
 * (the legacy flat form is rejected by the layout reader afterwards).
 */
export async function migratePages(projectDir: string, options: MigratePagesOptions): Promise<void> {
  const { printer } = options;
  const pagesDir = join(projectDir, 'pages');
  let entries;
  try {
    entries = await readdir(pagesDir, { withFileTypes: true });
  } catch {
    printer.log('No pages directory — nothing to migrate.');
    return;
  }

  const moved: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.layout.json') || entry.name === 'app.layout.json') continue;
    const id = entry.name.slice(0, -'.layout.json'.length);
    if (id === '' || id === 'app') {
      skipped.push(`${entry.name} (reserved id)`);
      continue;
    }
    const pageDir = join(pagesDir, id);
    if (await exists(join(pagesDir, id, 'layout.json'))) {
      skipped.push(`${entry.name} (already migrated)`);
      continue;
    }
    if ((await exists(join(pageDir, 'show.layout.json'))) || (await exists(join(pageDir, 'list.layout.json')))) {
      skipped.push(`${entry.name} (collides with an object page dir)`);
      continue;
    }
    await mkdir(pageDir, { recursive: true });
    await rename(join(pagesDir, entry.name), join(pageDir, 'layout.json'));
    moved.push(entry.name);
  }

  // relocate canonical object client scripts `objects/<X>/*.client.js` → `pages/<X>/<kind>.client.js`
  const objectsDir = join(projectDir, 'objects');
  let objectEntries: Dirent[] = [];
  try {
    objectEntries = await readdir(objectsDir, { withFileTypes: true });
  } catch {
    objectEntries = [];
  }
  const scriptMoves: Array<{ from: string; to: string }> = [];
  for (const entry of objectEntries) {
    if (!entry.isDirectory()) continue;
    const objectDir = join(objectsDir, entry.name);
    for (const kind of ['show.client', 'list.client']) {
      const from = join(objectDir, `${kind}.js`);
      if (await exists(from)) {
        const to = join(pagesDir, entry.name, `${kind}.js`);
        await mkdir(join(pagesDir, entry.name), { recursive: true });
        await rename(from, to);
        scriptMoves.push({ from: `objects/${entry.name}/${kind}.js`, to: `pages/${entry.name}/${kind}.js` });
      }
    }
  }

  // drop the intermediate page-level and block-level client script files (new model: page × object faces only).
  // Object dirs are skipped — their `show.client.js`/`list.client.js` are the relocated canonical scripts.
  const staleScriptPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(join(objectsDir, entry.name))) continue; // object canonical dir
    const pageDir = join(pagesDir, entry.name);
    if ((await exists(join(pageDir, 'show.layout.json'))) || (await exists(join(pageDir, 'list.layout.json')))) {
      continue; // object page dir
    }
    for (const kind of ['show.client.js', 'list.client.js']) {
      const p = join(pageDir, kind);
      if (await exists(p)) {
        await rm(p, { force: true });
        staleScriptPaths.push(`pages/${entry.name}/${kind}`);
      }
    }
    const blocksDir = join(pageDir, 'blocks');
    if (await exists(blocksDir)) {
      await rm(blocksDir, { recursive: true, force: true });
      staleScriptPaths.push(`pages/${entry.name}/blocks`);
    }
  }

  const commitPathsList: string[] = [];
  for (const file of moved) {
    const oldRel = `pages/${file}`;
    // the legacy flat file is gone from disk — include its deletion only if it was tracked
    const tracked = (await runGit(['ls-files', '--error-unmatch', '--', oldRel], { cwd: projectDir, allowFailure: true })).code === 0;
    commitPathsList.push(`pages/${file.slice(0, -'.layout.json'.length)}`);
    if (tracked) commitPathsList.push(oldRel);
  }
  for (const move of scriptMoves) {
    commitPathsList.push(move.from, move.to);
  }
  commitPathsList.push(...staleScriptPaths);

  if (commitPathsList.length > 0) {
    const commit = await commitPaths({
      dir: projectDir,
      paths: commitPathsList,
      message: 'chore(pages): migrate custom pages + relocate object client scripts',
    });
    printer.log(
      `Migrated ${moved.length} custom page(s), moved ${scriptMoves.length} object script(s), removed ${staleScriptPaths.length} stale script path(s)${commit.committed ? '' : ' (no changes committed)'}.`,
    );
  } else {
    printer.log('No legacy flat custom pages to migrate.');
  }
  for (const file of skipped) {
    printer.log(`Skipped: ${file}`);
  }
}

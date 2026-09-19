import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { detectScriptHooks, SchemaError, type ScriptHook } from '../../core/index.js';

export interface LoadedScript {
  /** object name (the parent directory name of server.js) */
  name: string;
  /** absolute path to the server.js file */
  path: string;
  /** raw source, sent to the sandbox for compilation */
  source: string;
  /** hook names detected statically (fast-path registration; compile happens in the sandbox) */
  hooks: ScriptHook[];
}

async function collectScriptFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectScriptFiles(full, out);
    } else if (entry.isFile() && entry.name === 'server.js') {
      out.push(full);
    }
  }
}

/**
 * Discover `objects/<name>/server.js` files. `.client.js` (a frontend concern)
 * and `schema.json` are deliberately ignored. A syntax error is not detected
 * here — the sandbox reports `script.compile` on first dispatch.
 */
export async function loadScriptDir(objectsDir: string): Promise<LoadedScript[]> {
  let paths: string[] = [];
  try {
    await collectScriptFiles(objectsDir, paths);
  } catch {
    throw new SchemaError('loader.dir.missing', { dir: objectsDir });
  }
  paths = paths.sort();

  const scripts: LoadedScript[] = [];
  for (const path of paths) {
    const name = basename(dirname(path));
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      throw new SchemaError('loader.file.read', { file: path });
    }
    scripts.push({ name, path, source, hooks: detectScriptHooks(source) });
  }
  return scripts;
}

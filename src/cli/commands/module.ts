import { readFile, writeFile } from 'node:fs/promises';
import { autoCommit } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { ModuleOptions } from '../types/index.js';

/** subsystems that can be toggled with `weave module:add/remove` (workflow is not implemented yet) */
export const TOGGLEABLE_SUBSYSTEMS = ['audit', 'script'] as const;

/**
 * Set a subsystem's `enabled` flag inside `weavekit.config.ts` (the config is
 * the truth source). Supports the standard generated shape; returns `null` when
 * the source has no recognizable insertion point so the caller can error out
 * with a "edit manually" hint instead of corrupting the file.
 */
export function setSubsystemEnabled(source: string, name: string, enabled: boolean): string | null {
  const entry = new RegExp(`([^A-Za-z0-9_])${name}:\\s*\\{\\s*enabled:\\s*(true|false)\\s*\\},?`);

  if (enabled) {
    // entry already present → flip disabled → enabled
    if (entry.test(source)) {
      return source.replace(entry, `$1${name}: { enabled: true },`);
    }
    // entry present but without an enabled flag → inject it
    const bare = new RegExp(`([^A-Za-z0-9_])${name}:\\s*\\{\\s*\\},?`);
    if (bare.test(source)) {
      return source.replace(bare, `$1${name}: { enabled: true },`);
    }
    // subsystems block exists → insert a new entry after its `{`
    const block = source.match(/(\n[ \t]*)subsystems\??:\s*\{/);
    if (block !== null) {
      const indent = block[1]!.replace(/^\n/, '');
      const innerIndent = `${indent}  `;
      const at = block.index! + block[0].length;
      return `${source.slice(0, at)}\n${innerIndent}${name}: { enabled: true },${source.slice(at)}`;
    }
    // no subsystems block → add one right after `export default {`
    const def = source.match(/export\s+default\s*\{/);
    if (def === null) return null;
    const at = def.index! + def[0].length;
    return `${source.slice(0, at)}\n  subsystems: {\n    ${name}: { enabled: true },\n  },${source.slice(at)}`;
  }

  // disable: flip enabled → false; a bare `name: {}` becomes `name: { enabled: false }`
  if (entry.test(source)) {
    return source.replace(entry, `$1${name}: { enabled: false },`);
  }
  const bare = new RegExp(`([^A-Za-z0-9_])${name}:\\s*\\{\\s*\\},?`);
  if (bare.test(source)) {
    return source.replace(bare, `$1${name}: { enabled: false },`);
  }
  return source; // already disabled / absent → no-op
}

async function readConfigSource(cwd: string): Promise<{ configPath: string; source: string }> {
  const config = await loadConfig(cwd);
  return { configPath: config.configPath, source: await readFile(config.configPath, 'utf8') };
}

async function reloadOk(cwd: string): Promise<boolean> {
  try {
    // cache-busting query forces a fresh import of the edited config
    await loadConfig(cwd);
    return true;
  } catch {
    return false;
  }
}

export async function moduleToggle(cwd: string, name: string, enable: boolean, options: ModuleOptions): Promise<void> {
  const p = options.printer;
  if (!(TOGGLEABLE_SUBSYSTEMS as readonly string[]).includes(name)) {
    p.error(`unsupported subsystem "${name}" (expected: ${TOGGLEABLE_SUBSYSTEMS.join(' or ')})`);
    process.exitCode = 1;
    return;
  }

  const { configPath, source } = await readConfigSource(cwd);
  const edited = setSubsystemEnabled(source, name, enable);
  if (edited === null) {
    p.error(
      `cannot edit ${configPath} automatically (unrecognized shape) — set \`subsystems: { ${name}: { enabled: ${enable} } }\` manually`,
    );
    process.exitCode = 1;
    return;
  }
  if (edited === source) {
    p.log(`subsystem "${name}" already ${enable ? 'enabled' : 'disabled'} — nothing to do`);
    p.data({ module: name, enabled: enable, changed: false });
    return;
  }

  await writeFile(configPath, edited);
  if (!(await reloadOk(cwd))) {
    await writeFile(configPath, source); // revert a broken edit
    p.error(`edited ${configPath} failed to load — reverted; please edit manually`);
    process.exitCode = 1;
    return;
  }

  const commit = await autoCommit({ dir: (await loadConfig(cwd)).schemaDir ?? cwd });
  p.log(`subsystem "${name}" ${enable ? 'enabled' : 'disabled'} (${configPath})${commit.committed ? ` · committed ${commit.sha}` : ''}`);
  p.data({ module: name, enabled: enable, changed: true, committed: commit.committed });
}

import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineConfig } from '../index.js';

const CONFIG_FILES = ['weavekit.config.ts', 'weavekit.config.js'] as const;

export interface LoadedConfig extends EngineConfig {
  /** absolute path of the resolved config file */
  configPath: string;
}

async function findConfig(cwd: string): Promise<string | undefined> {
  for (const file of CONFIG_FILES) {
    const full = resolve(cwd, file);
    try {
      if ((await stat(full)).isFile()) return full;
    } catch {
      // not this candidate
    }
  }
  return undefined;
}

/**
 * Load `weavekit.config.ts` from a project directory. `schemaDir` is resolved
 * to an absolute path relative to the config file. Throws a plain Error when
 * the file is missing or does not export a default config object.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const configPath = await findConfig(cwd);
  if (configPath === undefined) {
    throw new Error(`no weavekit.config.ts found in ${cwd} (run "bun create weavekit-app" first)`);
  }
  const mod = await import(pathToFileURL(configPath).href);
  const config: unknown = mod.default;
  if (config === undefined || typeof config !== 'object' || config === null) {
    throw new Error(`weavekit.config.ts must export a config object (export default { ... })`);
  }
  const base = dirname(configPath);
  const loaded = config as EngineConfig;
  if (loaded.schemaDir !== undefined) {
    loaded.schemaDir = isAbsolute(loaded.schemaDir) ? loaded.schemaDir : resolve(base, loaded.schemaDir);
  }
  return { ...loaded, configPath };
}

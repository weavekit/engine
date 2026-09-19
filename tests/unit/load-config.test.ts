import { describe, it, expect } from '../helpers/test.js';import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/cli/load-config.js';

const CONFIG = `import type { EngineConfig } from '@weave-kit/engine';\n
export default {
  schemaDir: './objects',
  auth: { source: { 'sk-admin': { id: 'admin', roles: ['admin'] } } },
} satisfies EngineConfig;
`;

async function withProjectDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'weavekit-config-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('loadConfig — weavekit.config.ts loading', () => {
  it('loads default export and resolves schemaDir to an absolute path', async () => {
    await withProjectDir(async (root) => {
      await writeFile(join(root, 'weavekit.config.ts'), CONFIG);
      const config = await loadConfig(root);
      expect(config.schemaDir).toBe(join(root, 'objects'));
      expect(config.auth?.source).toEqual({ 'sk-admin': { id: 'admin', roles: ['admin'] } });
      expect(config.configPath).toBe(join(root, 'weavekit.config.ts'));
    });
  });

  it('missing config file → error suggesting create-weavekit-app', async () => {
    await withProjectDir(async (root) => {
      let threw: unknown;
      try {
        await loadConfig(root);
      } catch (error) {
        threw = error;
      }
      expect(threw instanceof Error).toBe(true);
      expect((threw as Error).message).toContain('weavekit-app');
    });
  });

  it('config without default export → error', async () => {
    await withProjectDir(async (root) => {
      await writeFile(join(root, 'weavekit.config.ts'), 'export const x = 1;\n');
      let threw: unknown;
      try {
        await loadConfig(root);
      } catch (error) {
        threw = error;
      }
      expect((threw as Error).message).toContain('export default');
    });
  });

  it('existing schemaDir subdirectory is not appended again', async () => {
    await withProjectDir(async (root) => {
      await mkdir(join(root, 'objects'), { recursive: true });
      await writeFile(join(root, 'weavekit.config.ts'), CONFIG);
      const config = await loadConfig(root);
      expect(config.schemaDir).toBe(join(root, 'objects'));
    });
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '../helpers/test.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** every pure constants module re-exported by the `values` barrel */
const VALUES_MODULES = [
  'core/types/values.ts',
  'runtime/data-access/values.ts',
  'core/formula/values.ts',
  'core/tools/values.ts',
  'core/script/values.ts',
  'cli/types/values.ts',
];

describe('values barrel is browser-safe (@weave-kit/engine/values)', () => {
  it('each values source file has zero imports (pure as-const leaf, safe for browser bundle)', () => {
    for (const rel of VALUES_MODULES) {
      const src = readFileSync(join(srcRoot, rel), 'utf8');
      const imports = src.match(/^\s*import\s/m) ?? [];
      const requires = src.match(/require\(/g) ?? [];
      expect(imports.length).toBe(0);
      expect(requires.length).toBe(0);
    }
  });

  it('barrel only re-exports relative values modules, imports no node:/packages', () => {
    const src = readFileSync(join(srcRoot, 'values.ts'), 'utf8');
    const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith('./')).toBe(true);
      expect(spec.match(/node:|@weave-kit|\bpg\b|fastify|isolated-vm/)).toBeNull();
    }
  });

  it('layout-format uses type-only imports only (browser-safe)', () => {
    const src = readFileSync(join(srcRoot, 'layout-format.ts'), 'utf8');
    const runtimeImports = src.match(/^\s*import\s(?!type\b)/m) ?? [];
    expect(runtimeImports.length).toBe(0);
    expect(src.match(/require\(/g) ?? []).toHaveLength(0);
  });
});

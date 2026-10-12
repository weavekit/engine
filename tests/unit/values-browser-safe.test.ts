import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '../helpers/test.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** every constants module re-exported by the `values` barrel */
const VALUES_MODULES = [
  'core/types/values.ts',
  'runtime/data-access/values.ts',
  'core/formula/values.ts',
  'core/tools/values.ts',
  'core/script/values.ts',
  'cli/types/values.ts',
];

/** the shared contract values entry is itself browser-safe (pure as-const) */
const CONTRACT_VALUES = '@weave-kit/contract/values';

describe('values barrel is browser-safe (@weave-kit/engine/values)', () => {
  it('each values source is a pure as-const leaf or a thin @weave-kit/contract re-export', () => {
    for (const rel of VALUES_MODULES) {
      const src = readFileSync(join(srcRoot, rel), 'utf8');
      expect(src.match(/require\(/g) ?? []).toHaveLength(0);
      const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(spec.startsWith('./') || spec === CONTRACT_VALUES).toBe(true);
      }
    }
  });

  it('barrel only re-exports relative values modules + the contract values entry', () => {
    const src = readFileSync(join(srcRoot, 'values.ts'), 'utf8');
    const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      const ok = spec.startsWith('./') || spec === CONTRACT_VALUES;
      expect(ok).toBe(true);
      expect(spec.match(/node:|\bpg\b|fastify|isolated-vm/)).toBeNull();
    }
  });
});

import { describe, it, expect } from '../helpers/test.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { version } from '../../src/version.js';

describe('version', () => {
  it('src/version.ts matches package.json (scaffold injects this into generated deps)', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(version).toBe(pkg.version);
  });
});

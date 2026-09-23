import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import type { BuildOptions } from '../types/index.js';

/** `weave build` — bundle the server entry for production (esbuild, node platform) */
export async function build(cwd: string, options: BuildOptions): Promise<void> {
  const p = options.printer;
  const entry = resolve(cwd, options.entry ?? 'main.ts');
  try {
    if (!(await stat(entry)).isFile()) throw new Error('missing');
  } catch {
    throw new Error(`entry not found: ${entry} (run "npm create weavekit-app" to scaffold main.ts)`);
  }

  const outdir = resolve(cwd, 'dist');
  await esbuild({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    outdir,
    outbase: dirname(entry),
    // native addons must stay external — resolved at runtime from node_modules
    // (isolated-vm = V8 isolates; pgsql-parser family = libpg-query WASM, which
    // loads its .wasm via a __dirname-relative path that bundling would break)
    external: ['isolated-vm', 'pgsql-parser', 'libpg-query', 'pgsql-deparser', '@pgsql/*'],
    logLevel: 'silent',
  });
  p.log(`bundled ${entry} → ${outdir}/main.js`);

  // custom tools: compile tools/*.ts → dist/tools/*.js so the production
  // engine (no tsx register) can dynamic-import compiled products. Point
  // `tools.toolsDir` at `dist/tools` in production. `weave dev` needs no step —
  // tsx is registered there and the loader accepts `.ts`.
  const toolsDir = resolve(cwd, 'tools');
  try {
    if ((await stat(toolsDir)).isDirectory()) {
      await esbuild({
        entryPoints: [join(toolsDir, '*.ts')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        outdir: resolve(cwd, 'dist/tools'),
        logLevel: 'silent',
      });
      p.log('compiled tools/*.ts → dist/tools/');
    }
  } catch {
    // no tools directory — nothing to compile
  }

  // open registration: compile field-types/*.ts → dist/field-types/*.js so the
  // production engine can dynamic-import compiled registrations. Point
  // `fieldTypes.dir` at `dist/field-types` in production. `weave dev` needs no
  // step — tsx is registered there and the loader accepts `.ts`.
  const fieldTypesDir = resolve(cwd, 'field-types');
  try {
    if ((await stat(fieldTypesDir)).isDirectory()) {
      await esbuild({
        entryPoints: [join(fieldTypesDir, '*.ts')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        outdir: resolve(cwd, 'dist/field-types'),
        logLevel: 'silent',
      });
      p.log('compiled field-types/*.ts → dist/field-types/');
    }
  } catch {
    // no field-types directory — nothing to compile
  }

  p.data({ entry, outdir });
}

#!/usr/bin/env node
/**
 * Verify the published package surface (run **after** `npm run build`):
 *   - every `exports` subpath target (`types` + `default`) exists on disk
 *   - the public `.` entry loads and exposes the frozen contract names
 *   - the browser-safe `./values` / `./layout` entries exist
 *
 * Fails the build on any drift between `package.json#exports` and `dist/`, or a
 * missing contract export — so a bad `exports` map or a broken barrel is caught
 * in CI instead of by consumers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const errors = [];

for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  if (typeof entry === 'string') {
    if (!existsSync(resolve(root, entry))) errors.push(`exports["${subpath}"] -> missing ${entry}`);
    continue;
  }
  for (const [condition, target] of Object.entries(entry)) {
    if (!existsSync(resolve(root, target))) errors.push(`exports["${subpath}"].${condition} -> missing ${target}`);
  }
}

/** frozen / critical public names a consumer (or the enterprise layer) relies on */
const REQUIRED = [
  'version',
  'CONTRACT_VERSION',
  'SCHEMA_FORMAT_VERSION',
  'WORKFLOW_FORMAT_VERSION',
  'CURSOR_VERSION',
  'createEngine',
  'buildEngineFromRegistry',
  'createPool',
  'migrate',
  'loadSchemaDir',
  'createDataAccess',
  'withRbac',
  'runPipeline',
  'AUDIT_MODES',
  'METRIC_NAMES',
  'parseTraceparent',
  'createAuth',
];

try {
  const mod = await import(pathToFileURL(resolve(root, 'dist/index.js')).href);
  for (const name of REQUIRED) {
    if (mod[name] === undefined) errors.push(`dist/index.js does not export "${name}"`);
  }
} catch (error) {
  errors.push(`dist/index.js failed to import: ${error instanceof Error ? error.message : String(error)}`);
}

for (const sub of ['dist/values.js', 'dist/layout-format.js']) {
  if (!existsSync(resolve(root, sub))) errors.push(`missing ${sub}`);
}

if (errors.length > 0) {
  console.error('package-exports check FAILED:');
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('package-exports check OK');

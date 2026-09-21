import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the generic OpenAPI document that the public docs site renders
 * (`docs.weavekit.io/engine/reference/api`). No objects: the reference documents
 * the engine's generic surface, not any specific project. Run via
 * `npm run openapi:docs`; the output is committed and drift-checked in CI.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildOpenApiDocument } = await import('../src/adapters/openapi/index.js');

const document = buildOpenApiDocument({
  objects: [],
  generic: true,
  capabilities: {
    prefix: '/api',
    events: { prefix: '/api' },
    ingress: { prefix: '/api' },
    audit: true,
    approvals: true,
    proxy: true,
    guardrails: true,
    projectDir: true,
    mcp: { endpoint: '/mcp' },
  },
});

await mkdir(join(root, 'openapi'), { recursive: true });
await writeFile(join(root, 'openapi', 'engine.json'), `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote openapi/engine.json (${Object.keys(document.paths).length} paths)`);

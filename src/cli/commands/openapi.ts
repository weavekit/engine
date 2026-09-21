import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { buildOpenApiDocument, capabilitiesFromConfig } from '../../adapters/openapi/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { OpenApiOptions } from '../types/index.js';

/**
 * `weave openapi` — emit an OpenAPI 3.1 document for this project's REST API.
 * Pure file work (no database): load `schema.json` + config, build the document,
 * write it. `--generic` omits per-object component schemas (used for the docs
 * reference); `--out -` prints to stdout.
 */
export async function openapi(cwd: string, options: OpenApiOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;

  const objects: import('../../core/index.js').ObjectDefinition[] = [];
  if (options.generic !== true) {
    const { files } = await loadSchemaDir(schemaDir, {
      locale: config.locale,
      allowedFieldTypes: config.features?.fieldTypes,
    });
    objects.push(...files.map((f) => f.object));
  }

  const document = buildOpenApiDocument({
    objects,
    capabilities: capabilitiesFromConfig(config),
    generic: options.generic,
    server: options.server,
  });

  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (options.out === '-') {
    process.stdout.write(json);
    return;
  }

  const outfile =
    options.out === undefined ? join(cwd, 'openapi.json') : isAbsolute(options.out) ? options.out : resolve(cwd, options.out);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, json);

  const paths = Object.keys(document.paths).length;
  const schemas = Object.keys(document.components.schemas).length;
  p.log(`wrote ${outfile} (${paths} path(s), ${schemas} schema(s))`);
  p.data({ outfile, paths, schemas });
}

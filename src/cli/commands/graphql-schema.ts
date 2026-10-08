import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { buildGraphQLSchema, printGraphQLSchema } from '../../adapters/graphql/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import type { GraphQLSchemaOptions } from '../types/index.js';

/**
 * `weave graphql:schema [--out <file>]` — print (or write) the GraphQL SDL for
 * this project's objects. Pure file work (no database): load `schema.json` +
 * config, compile the schema, then `printSchema`. `--out -` (or no `--out`)
 * prints to stdout.
 */
export async function graphqlSchema(cwd: string, options: GraphQLSchemaOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;
  const fieldTypes = await resolveProjectFieldTypes(cwd, config);

  const { registry } = await loadSchemaDir(schemaDir, {
    locale: config.locale,
    allowedFieldTypes: config.features?.fieldTypes,
    fieldTypes,
  });
  registry.buildGraph({ locale: config.locale });

  const sdl = `${printGraphQLSchema(buildGraphQLSchema({ registry })).trimEnd()}\n`;

  if (options.out === undefined || options.out === '-') {
    process.stdout.write(sdl);
    return;
  }

  const outfile = isAbsolute(options.out) ? options.out : resolve(cwd, options.out);
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, sdl);
  p.log(`wrote ${outfile} (${registry.list().length} object(s))`);
  p.data({ outfile, objects: registry.list().length });
}

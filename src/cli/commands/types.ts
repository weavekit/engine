import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateObjectTypes } from '../../core/index.js';
import { autoCommit, loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import type { TypeOptions } from '../types/index.js';

/** `weave types` — compile schema.json into object-level TS types (`generated/types.ts`) */
export async function types(cwd: string, options: TypeOptions): Promise<void> {
  const p = options.printer;
  const config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;

  const { files } = await loadSchemaDir(schemaDir, { locale: config.locale, allowedFieldTypes: config.features?.fieldTypes });
  const source = generateObjectTypes(files.map((f) => f.object));

  const outdir = options.outdir === undefined ? join(cwd, 'generated') : join(cwd, options.outdir);
  await mkdir(outdir, { recursive: true });
  const outfile = join(outdir, 'types.ts');
  await writeFile(outfile, source);

  const commit = await autoCommit({ dir: schemaDir, paths: ['generated'] });
  p.log(`wrote ${outfile} (${files.length} object(s))${commit.committed ? ` · committed ${commit.sha}` : ''}`);
  p.data({ outfile, objects: files.map((f) => f.name), committed: commit.committed });
}

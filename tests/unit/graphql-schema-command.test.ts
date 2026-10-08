import { describe, it, expect } from '../helpers/test.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphqlSchema } from '../../src/cli/commands/graphql-schema.js';
import type { CliPrinter } from '../../src/cli/render.js';

const printer: CliPrinter = {
  json: true,
  kv() {},
  table() {},
  data() {},
  log() {},
  error() {},
};

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wk-gql-schema-'));
  await mkdir(join(root, 'objects', 'lead'), { recursive: true });
  await writeFile(
    join(root, 'objects', 'lead', 'schema.json'),
    `${JSON.stringify({
      schemaVersion: 6,
      name: 'lead',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'title', type: 'string' },
        { name: 'status', type: 'enum', options: ['open', 'won'] },
      ],
    })}\n`,
  );
  await writeFile(join(root, 'weavekit.config.ts'), "export default { schemaDir: '.' };\n");
  return root;
}

describe('weave graphql:schema', () => {
  it('writes the project GraphQL SDL to --out', async () => {
    const root = await makeProject();
    try {
      const out = join(root, 'graphql', 'schema.graphql');
      await graphqlSchema(root, { out, printer });
      const sdl = await readFile(out, 'utf8');
      expect(sdl).toContain('type Lead {');
      expect(sdl).toContain('type Query {');
      expect(sdl).toContain('type Mutation {');
      expect(sdl).toContain('enum LeadStatus {');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

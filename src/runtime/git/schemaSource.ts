import {
  ObjectRegistry,
  SchemaError,
  parseSchema,
  type Locale,
} from '../../core/index.js';
import type { AutoCommitOptions } from './autoCommit.js';
import { readSource, sourceVersion } from './sourceFile.js';
import { runSourceTransaction } from './sourceTransaction.js';

/**
 * Raw schema source store: read/write `objects/<name>/schema.json`.
 * PUT runs the same validation as the loader — single-object `parseSchema`
 * plus the full cross-object graph over the whole registry — and never applies
 * DDL (structural changes take effect on the next `weave dev`/`migrate`).
 */

export interface SchemaSourceDocument {
  source: string;
  version: string;
}

export interface WriteSchemaSourceOptions {
  projectDir: string;
  registry: ObjectRegistry;
  name: string;
  source: string;
  expectVersion?: string;
  force?: boolean;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
  allowedFieldTypes?: readonly string[];
}

export interface WriteSchemaSourceResult extends SchemaSourceDocument {
  committed: boolean;
}

export function schemaPathOf(name: string): string {
  return `objects/${name}/schema.json`;
}

export async function readSchemaSource(
  projectDir: string,
  name: string,
): Promise<SchemaSourceDocument | null> {
  return readSource(projectDir, schemaPathOf(name));
}

/** validate a schema candidate against the whole registry (parse + buildGraph) */
export function validateSchemaCandidate(options: {
  registry: ObjectRegistry;
  name: string;
  source: string;
  locale?: Locale;
  allowedFieldTypes?: readonly string[];
}): void {
  const { registry, name, source, locale, allowedFieldTypes } = options;
  if (registry.get(name) === undefined) {
    throw new SchemaError('data.objectUnknown', { object: name }, locale);
  }
  const candidate = parseSchema(source, { locale, nameHint: name, allowedFieldTypes });
  const temp = new ObjectRegistry();
  for (const def of registry.list()) {
    if (def.name !== name) temp.register(def, { locale, allowedFieldTypes });
  }
  temp.register(candidate, { locale, allowedFieldTypes });
  temp.buildGraph({ locale });
}

export async function writeSchemaSource(
  options: WriteSchemaSourceOptions,
): Promise<WriteSchemaSourceResult> {
  const { projectDir, registry, name, source, expectVersion, force, identity, locale, allowedFieldTypes } = options;
  validateSchemaCandidate({ registry, name, source, locale, allowedFieldTypes });
  const result = await runSourceTransaction({
    projectDir,
    files: [{ path: schemaPathOf(name), source, expectVersion }],
    force,
    identity,
    locale,
    message: `chore(schema): update ${name}`,
  });
  return { source, version: sourceVersion(source), committed: result.committed };
}

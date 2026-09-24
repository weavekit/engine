import type { Locale } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/index.js';
import { WORKFLOW_FORMAT_VERSION } from '../types/workflow.js';
import { SchemaError } from '../types/errors.js';

type RawWorkflow = Record<string, unknown>;

function isRecord(value: unknown): value is RawWorkflow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * On-disk `workflow.json` format migrations: `from`-version → a transform
 * producing version+1. Mirror of `core/object/migrations.ts` for the sibling
 * workflow file; append a step here whenever {@link WORKFLOW_FORMAT_VERSION} is
 * bumped. Steps must be pure (no files/database).
 */
const WORKFLOW_MIGRATIONS: Record<number, (raw: RawWorkflow) => RawWorkflow> = {
  // v0 (unversioned) → v1: make the format version explicit.
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

/** the declared format version of a raw `workflow.json` (absent = legacy 0) */
export function workflowFormatVersionOf(raw: RawWorkflow, locale: Locale = DEFAULT_LOCALE): number {
  const value = raw.schemaVersion;
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SchemaError(
      'schema.version.unsupported',
      { version: String(value), supported: WORKFLOW_FORMAT_VERSION },
      locale,
    );
  }
  if (value > WORKFLOW_FORMAT_VERSION) {
    throw new SchemaError(
      'schema.version.unsupported',
      { version: value, supported: WORKFLOW_FORMAT_VERSION },
      locale,
    );
  }
  return value;
}

export interface MigratedWorkflow {
  /** the workflow definition at the current format version */
  workflow: RawWorkflow;
  /** the version the input was at (0 for unversioned files) */
  from: number;
  /** true when at least one migration step ran */
  migrated: boolean;
}

/**
 * Bring a raw `workflow.json` up to the current on-disk format (pure). Used by
 * `weave workflow:upgrade` (the loader reads older files directly — the runtime
 * validator is permissive about the on-disk format version).
 */
export function migrateWorkflowObject(
  raw: RawWorkflow,
  locale: Locale = DEFAULT_LOCALE,
): MigratedWorkflow {
  let version = workflowFormatVersionOf(raw, locale);
  const from = version;
  let current = raw;
  while (version < WORKFLOW_FORMAT_VERSION) {
    const step = WORKFLOW_MIGRATIONS[version];
    if (step === undefined) {
      throw new SchemaError(
        'schema.version.unsupported',
        { version, supported: WORKFLOW_FORMAT_VERSION },
        locale,
      );
    }
    current = step(current);
    version += 1;
  }
  return { workflow: current, from, migrated: current !== raw };
}

/** true when `value` is a plain workflow object (guards JSON.parse output) */
export function isWorkflowObject(value: unknown): value is RawWorkflow {
  return isRecord(value);
}

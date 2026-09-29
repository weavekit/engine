import type { Locale } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/index.js';
import { WORKFLOW_FORMAT_VERSION } from '../types/workflow.js';
import { SchemaError } from '../types/errors.js';

type RawWorkflow = Record<string, unknown>;

function isRecord(value: unknown): value is RawWorkflow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): RawWorkflow[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function rolesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
}

/**
 * Best-effort linearization of a v1 state machine (`states[]` + `transitions[]`)
 * into a v2 single-line `nodes[]`. The implicit start node replaces the old
 * `initial` state. Roles are gathered from the transitions touching each state;
 * a state with no derivable roles falls back to `['*']` (fail-closed at runtime
 * until the author edits it). There are no v1 users in the wild, so this path is
 * exercised only by tests / deliberate upgrades.
 */
function linearizeV1(raw: RawWorkflow): RawWorkflow[] {
  const initial = typeof raw.initial === 'string' ? raw.initial : undefined;
  const states = asArray(raw.states);
  const transitions = asArray(raw.transitions);
  const allRoles = [...new Set(transitions.flatMap((t) => rolesOf(t.roles)))];

  const rolesFor = (name: string): string[] => {
    const into = transitions.find((t) => t.to === name && rolesOf(t.roles).length > 0);
    if (into !== undefined) return rolesOf(into.roles);
    const out = transitions.find((t) => t.from === name && rolesOf(t.roles).length > 0);
    if (out !== undefined) return rolesOf(out.roles);
    return allRoles.length > 0 ? allRoles : ['*'];
  };

  const order = states
    .map((s) => s.name)
    .filter((n): n is string => typeof n === 'string' && n !== initial);
  const position = new Map(order.map((n, idx) => [n, idx]));

  return order.map((name) => {
    const state = states.find((s) => s.name === name);
    const labels = isRecord(state?.labels) ? state.labels : undefined;
    const reject = transitions.find(
      (t) => t.from === name && typeof t.action === 'string' && t.action.includes('reject'),
    );
    const onReject =
      reject !== undefined &&
      typeof reject.to === 'string' &&
      reject.to !== initial &&
      position.has(reject.to) &&
      (position.get(reject.to) as number) < (position.get(name) as number)
        ? reject.to
        : undefined;
    const timeout = isRecord(state?.onTimeout) && typeof state.onTimeout.after === 'string'
      ? {
          after: state.onTimeout.after,
          action: typeof state.onTimeout.action === 'string' && state.onTimeout.action.includes('reject')
            ? ('reject' as const)
            : ('approve' as const),
        }
      : undefined;
    return {
      id: name,
      ...(labels === undefined ? {} : { name: labels }),
      assign: { roles: rolesFor(name) },
      ...(onReject === undefined ? {} : { onReject }),
      ...(timeout === undefined ? {} : { onTimeout: timeout }),
    };
  });
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
  // v1 (states/transitions) → v2 (single-line nodes chain).
  1: (raw) => ({
    schemaVersion: 2,
    ...(raw.version === undefined ? {} : { version: raw.version }),
    nodes: linearizeV1(raw),
  }),
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
 * the loader (read-time normalization of older files) and `weave workflow:upgrade`.
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

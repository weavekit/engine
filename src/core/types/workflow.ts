/**
 * Declarative per-object state machine (`objects/<name>/workflow.json`).
 * Pure types — zero runtime dependencies (core contract layer).
 */

/** on-disk `workflow.json` format version (single source of truth) */
export const WORKFLOW_FORMAT_VERSION = 1 as const;

/** how long a state may be held before its timeout fires, and what to do then */
export interface WorkflowTimeout {
  /** duration string: `<n>` with optional unit `ms|s|m|h|d|w` (bare number = ms) */
  after: string;
  /** transition action to auto-fire on expiry; absent = only dispatch the `onTimeout` hook */
  action?: string;
}

/** one named state a record can be in (must be one of the state field's enum options) */
export interface WorkflowState {
  /** snake_case state name; must exist in the state field's inline options */
  name: string;
  /** display names keyed by locale, e.g. { en: 'Draft', zh: '草稿' } */
  labels?: Record<string, string>;
  description?: string;
  /** optional timeout: the clock starts when the state is entered */
  onTimeout?: WorkflowTimeout;
}

/** one guarded edge between two states */
export interface WorkflowTransition {
  /** snake_case action name, unique within a `from` state */
  action: string;
  /** source state name */
  from: string;
  /** target state name */
  to: string;
  labels?: Record<string, string>;
  /** roles allowed to fire this transition; absent = any identity allowed to update */
  roles?: string[];
  /** when true, the transition must be approved through the approval queue before it fires */
  requiresApproval?: boolean;
}

/** validated workflow definition attached to an object */
export interface WorkflowDefinition {
  /** on-disk `workflow.json` format version */
  schemaVersion?: number;
  /** enum field on the object that carries the current state */
  stateField: string;
  /** state assigned to new records */
  initial: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

/** `weavekit.config.ts -> subsystems.workflow` */
export interface EngineWorkflowConfig {
  enabled?: boolean;
  /** scheduler poll interval in ms; defaults to `WORKFLOW_TIMER_DEFAULTS.pollMs` */
  pollMs?: number;
  /** timers claimed per tick; defaults to `WORKFLOW_TIMER_DEFAULTS.batchSize` */
  batchSize?: number;
  /** pluggable durable timer backend (defaults to the PG `weavekit_workflow_timers` store) */
  backend?: WorkflowBackend;
}

/** scheduler defaults — single source of truth (as const, see AGENTS.md) */
export const WORKFLOW_TIMER_DEFAULTS = {
  pollMs: 30000,
  batchSize: 50,
} as const;

/** one armed timeout for a record's current state */
export interface WorkflowTimer {
  object: string;
  id: string;
  state: string;
  dueAt: Date;
}

/**
 * Durable timer store — the engine ships a PostgreSQL default
 * (`weavekit_workflow_timers`, claimed with `FOR UPDATE SKIP LOCKED`). The
 * seam lets an enterprise backend (e.g. Redis/HA coordination) plug in without
 * forking core; the engine never imports a non-PG implementation.
 */
export interface WorkflowTimerStore {
  /** attach/refresh the single timer for a record (one per record) */
  schedule(timer: WorkflowTimer): Promise<void>;
  /** remove any timer for the record */
  cancel(object: string, id: string): Promise<void>;
  /** atomically take up to `limit` due timers (multi-instance safe) */
  claimDue(limit: number, now: Date): Promise<WorkflowTimer[]>;
  /** finalize a claimed timer (idempotent) */
  complete(timer: WorkflowTimer): Promise<void>;
}

/** umbrella seam: an alternative workflow backend (enterprise), default is the engine's PG store */
export interface WorkflowBackend {
  readonly timerStore: WorkflowTimerStore;
}

/**
 * Narrow timer handle injected into data-access: writes re-arm/cancel the
 * record's timer on state changes without knowing the scheduler/backend. The
 * engine wires the real scheduler at assembly (a no-op proxy before it exists).
 */
export interface WorkflowTimerSync {
  /** (re)arm the timer for the record's new state, or cancel when it has no `onTimeout` */
  sync(object: string, id: string, state: string): Promise<void>;
  /** cancel any timer for the record */
  cancel(object: string, id: string): Promise<void>;
}

/** duration units in milliseconds (single source of truth) */
const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** parse a duration string (`90s`, `30m`, `12h`, `7d`, `2w`, or a bare number of ms) */
export function parseDuration(input: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d|w)?$/.exec(input.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = (match[2] ?? 'ms') as keyof typeof DURATION_UNITS;
  return amount * DURATION_UNITS[unit];
}

/**
 * Workflow schema + durable timer contract.
 *
 * The `workflow.json` schema vocabulary (format version, node kinds, and the
 * node/assign/timeout/definition shapes) lives in `@weave-kit/contract` and is
 * re-exported here; this module keeps the engine-side timer/backend seams.
 */

export {
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_START_NODE,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_ASSIGN_MODES,
  WORKFLOW_TIMEOUT_ACTIONS,
} from '@weave-kit/contract/values';
export type {
  WorkflowNodeKind,
  WorkflowAssignMode,
  WorkflowTimeoutAction,
  WorkflowTimeout,
  WorkflowAssign,
  WorkflowNode,
  WorkflowDefinition,
} from '@weave-kit/contract';

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

/** one armed timeout for a record's current step */
export interface WorkflowTimer {
  object: string;
  id: string;
  /** the current node id the timeout is armed for */
  nodeId: string;
  dueAt: Date;
  /** semantic hash of the definition the timer was armed under */
  workflowHash?: string;
}

/**
 * Durable timer store — the engine ships a PostgreSQL default
 * (`weavekit_workflow_timers`, claimed with `FOR UPDATE SKIP LOCKED`). The
 * seam lets an enterprise backend (e.g. Redis/HA coordination) plug in without
 * forking core; the engine never imports a non-PG implementation.
 *
 * Stable seam (`@enterprise-reserved`): HA / multi-instance timer coordination
 * is enterprise E3.
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

/**
 * Umbrella seam: an alternative workflow backend (enterprise), default is the
 * engine's PG store. Stable seam (`@enterprise-reserved`) — enterprise E3.
 */
export interface WorkflowBackend {
  readonly timerStore: WorkflowTimerStore;
}

/**
 * Narrow timer handle injected into data-access: writes re-arm/cancel the
 * record's timer on node changes without knowing the scheduler/backend. The
 * engine wires the real scheduler at assembly (a no-op proxy before it exists).
 */
export interface WorkflowTimerSync {
  /** (re)arm the timer for the record's new node/state, or cancel when it has no `onTimeout` */
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

/**
 * Declarative single-line node-chain workflow (`objects/<name>/workflow.json`).
 * Pure types — zero runtime dependencies (core contract layer).
 *
 * Format v2 replaces the v1 state-marker machine (`stateField` + `states[]` +
 * `transitions[]`) with an ordered `nodes[]` chain driven by an implicit start
 * node. Instance/step/workitem state lives in engine tables, never in the
 * customer's columns (see the C-phase plan).
 */

/** on-disk `workflow.json` format version (single source of truth) */
export const WORKFLOW_FORMAT_VERSION = 2 as const;

/** synthetic node id of the implicit start (发起) node — never authored */
export const WORKFLOW_START_NODE = '__start__';

/** node kinds (single source of truth) */
export const WORKFLOW_NODE_KINDS = {
  APPROVE: 'approve',
  NOTIFY: 'notify',
} as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[keyof typeof WORKFLOW_NODE_KINDS];

/** how a node's assignees complete it (single source of truth) */
export const WORKFLOW_ASSIGN_MODES = {
  /** 或签: the first decision settles the node */
  ANY: 'any',
  /** 会签: every assignee must approve */
  ALL: 'all',
} as const;
export type WorkflowAssignMode = (typeof WORKFLOW_ASSIGN_MODES)[keyof typeof WORKFLOW_ASSIGN_MODES];

/** the actions a node timeout may auto-fire (single source of truth) */
export const WORKFLOW_TIMEOUT_ACTIONS = {
  APPROVE: 'approve',
  REJECT: 'reject',
} as const;
export type WorkflowTimeoutAction =
  (typeof WORKFLOW_TIMEOUT_ACTIONS)[keyof typeof WORKFLOW_TIMEOUT_ACTIONS];

/** how long a node may be held before its timeout fires, and what to do then */
export interface WorkflowTimeout {
  /** duration string: `<n>` with optional unit `ms|s|m|h|d|w` (bare number = ms) */
  after: string;
  /** action auto-fired on expiry; absent = only dispatch the `onTimeout` hook */
  action?: WorkflowTimeoutAction;
}

/** who acts at a node and how the node completes */
export interface WorkflowAssign {
  /** roles whose members resolve to the node's assignees (required, non-empty) */
  roles: string[];
  /** 或签 (`any`, default) | 会签 (`all`); `notify` nodes keep `any` */
  mode?: WorkflowAssignMode;
}

/** one node in the single-line chain */
export interface WorkflowNode {
  /** snake_case node id, unique within the chain */
  id: string;
  /** `approve` (default) | `notify` (抄送: no quorum, advances immediately) */
  kind?: WorkflowNodeKind;
  /** display names keyed by locale, e.g. { en: 'Finance', zh: '财务审批' } */
  name?: Record<string, string>;
  description?: string;
  /** roles that resolve to the node's assignees (required) */
  assign: WorkflowAssign;
  /** on reject, roll back to this earlier node id; absent = the start node */
  onReject?: string;
  /** on withdraw, roll back to this earlier node id; absent = the start node */
  onWithdraw?: string;
  /** node-level timeout (approve nodes only) */
  onTimeout?: WorkflowTimeout;
}

/** validated workflow definition attached to an object */
export interface WorkflowDefinition {
  /** on-disk `workflow.json` format version */
  schemaVersion?: number;
  /**
   * author-managed definition revision (an arbitrary positive integer, distinct
   * from the on-disk `schemaVersion`). Surfaced in the descriptor / transition
   * events + audit so history stays interpretable after a definition changes.
   * See `workflowHash` for the exact content identity (instance pinning).
   */
  version?: number;
  /** the ordered single-line node chain (the start node is implicit) */
  nodes: WorkflowNode[];
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

/** one armed timeout for a record's current step */
export interface WorkflowTimer {
  object: string;
  id: string;
  state: string;
  dueAt: Date;
  /** definition revision the timer was armed under (traceability) */
  workflowVersion?: number;
  /** semantic hash of the definition the timer was armed under */
  workflowHash?: string;
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

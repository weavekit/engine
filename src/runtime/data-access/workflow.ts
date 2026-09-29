import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  SchemaError,
  WEAVE_STATUS,
  WORKFLOW_START_NODE,
  parseDuration,
} from '../../core/index.js';
import type { IdentitySubject, Locale, WorkflowDefinition, WorkflowNode } from '../../core/index.js';
import { SYSTEM_TABLES } from '../../core/storage/system-tables.js';
import { upsertRecordMeta } from '../record-meta/index.js';

const q = (id: string) => `"${id}"`;
const T = SYSTEM_TABLES;
const USER_TABLE = 'weavekit_user';

/** the workflow action set (single source of truth) */
export const WORKFLOW_ACTIONS = {
  SUBMIT: 'submit',
  APPROVE: 'approve',
  REJECT: 'reject',
  WITHDRAW: 'withdraw',
  CANCEL: 'cancel',
  FORWARD: 'forward',
} as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[keyof typeof WORKFLOW_ACTIONS];

/** side-table `status` mirror values (map instance state → record status) */
const SIDE_STATUS: Record<string, string> = {
  running: WEAVE_STATUS.RUNNING,
  finished: WEAVE_STATUS.EFFECTIVE,
  canceled: WEAVE_STATUS.CANCELED,
};

interface InstanceRow {
  state: string;
  workflow_hash: string;
  current_step_id: string | null;
  originator: string;
  originator_parent: string | null;
}

interface StepRow {
  id: string;
  node_id: string;
  kind: string;
  ordinal: number;
  state: string;
}

interface WorkitemRow {
  id: string;
  step_id: string;
  node_id: string;
  kind: string;
  participant: string;
  state: string;
}

/** what the caller needs to audit / emit / re-arm timers after a transition */
export interface WorkflowTransitionOutcome {
  /** resulting instance state */
  state: 'running' | 'finished' | 'canceled';
  /** current active node id (running) — for the timeout scheduler */
  nodeId?: string;
  /** node the record left (for audit / the transitioned event) */
  fromNodeId?: string;
  /** node the record entered (for audit / the transitioned event) */
  toNodeId?: string;
}

export interface WorkflowRuntimeOptions {
  name: string;
  workflow?: WorkflowDefinition;
  workflowHash?: string;
}

/** load (and row-lock) the single instance for a record, if any */
async function loadInstance(
  client: PoolClient,
  object: string,
  recordKey: string,
): Promise<InstanceRow | undefined> {
  const res = await client.query(
    `SELECT state, workflow_hash, current_step_id, originator, originator_parent
       FROM ${q(T.WORKFLOW_INSTANCES)} WHERE object = $1 AND record_key = $2 FOR UPDATE`,
    [object, recordKey],
  );
  return res.rows[0] as InstanceRow | undefined;
}

/** the current active step of an instance (row-locked) */
async function loadActiveStep(client: PoolClient, stepId: string | null): Promise<StepRow | undefined> {
  if (stepId === null) return undefined;
  const res = await client.query(
    `SELECT id, node_id, kind, ordinal, state FROM ${q(T.WORKFLOW_STEPS)} WHERE id = $1 FOR UPDATE`,
    [stepId],
  );
  return res.rows[0] as StepRow | undefined;
}

/** open (active) workitems of a step (row-locked) */
async function loadOpenWorkitems(client: PoolClient, stepId: string): Promise<WorkitemRow[]> {
  const res = await client.query(
    `SELECT id, step_id, node_id, kind, participant, state
       FROM ${q(T.WORKFLOW_WORKITEMS)} WHERE step_id = $1 AND state = 'active' FOR UPDATE`,
    [stepId],
  );
  return res.rows as WorkitemRow[];
}

async function nextOrdinal(client: PoolClient, object: string, recordKey: string): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM ${q(T.WORKFLOW_STEPS)} WHERE object = $1 AND record_key = $2`,
    [object, recordKey],
  );
  return Number((res.rows[0] as { n: number }).n);
}

/** resolve node roles to internal user ids (`weavekit_user.roles` jsonb containment) */
async function resolveAssignees(client: PoolClient, roles: string[]): Promise<string[]> {
  if (roles.length === 0) return [];
  const res = await client.query(
    `SELECT id::text AS id FROM ${q(USER_TABLE)} WHERE enabled IS NOT FALSE AND roles ?| $1::text[]`,
    [roles],
  );
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/** resolve the definition an instance is pinned to (registry fast-path, else the registry table) */
async function resolveDefinition(
  client: PoolClient,
  def: WorkflowRuntimeOptions,
  hash: string,
  locale: Locale | undefined,
): Promise<WorkflowDefinition> {
  if (def.workflow !== undefined && def.workflowHash === hash) return def.workflow;
  const res = await client.query(
    `SELECT definition FROM ${q(T.WORKFLOW_DEFINITIONS)} WHERE object = $1 AND hash = $2`,
    [def.name, hash],
  );
  const row = res.rows[0] as { definition: WorkflowDefinition } | undefined;
  if (row === undefined) {
    throw new SchemaError('workflow.definition.missing', { object: def.name }, locale);
  }
  return row.definition;
}

/** content-address the current definition (idempotent, append-only) */
async function registerDefinition(
  client: PoolClient,
  object: string,
  hash: string,
  workflow: WorkflowDefinition,
): Promise<void> {
  await client.query(
    `INSERT INTO ${q(T.WORKFLOW_DEFINITIONS)} (object, hash, version_seq, definition)
     VALUES ($1, $2, (SELECT COALESCE(MAX(version_seq), 0) + 1 FROM ${q(T.WORKFLOW_DEFINITIONS)} WHERE object = $1), $3::jsonb)
     ON CONFLICT (object, hash) DO NOTHING`,
    [object, hash, JSON.stringify(workflow)],
  );
}

async function createStep(
  client: PoolClient,
  object: string,
  recordKey: string,
  nodeId: string,
  kind: string,
  prevStepId: string | null,
  now: Date,
): Promise<string> {
  const stepId = randomUUID();
  const ordinal = await nextOrdinal(client, object, recordKey);
  await client.query(
    `INSERT INTO ${q(T.WORKFLOW_STEPS)} (id, object, record_key, node_id, kind, ordinal, state, prev_step_id, entered_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
    [stepId, object, recordKey, nodeId, kind, ordinal, prevStepId, now],
  );
  return stepId;
}

interface WorkitemInput {
  object: string;
  recordKey: string;
  stepId: string;
  nodeId: string;
  kind: string;
  participant: string;
  state: string;
  approval?: string | null;
  action?: string | null;
  finisher?: string | null;
  delegant?: string | null;
  receiptor?: string | null;
  comment?: string | null;
  finishedAt?: Date | null;
  allowedAt?: Date | null;
}

async function insertWorkitem(client: PoolClient, w: WorkitemInput): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO ${q(T.WORKFLOW_WORKITEMS)}
       (id, object, record_key, step_id, node_id, kind, participant, state, approval, action,
        finisher, delegant, receiptor, comment, received_at, finished_at, allowed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15, $16)`,
    [
      id,
      w.object,
      w.recordKey,
      w.stepId,
      w.nodeId,
      w.kind,
      w.participant,
      w.state,
      w.approval ?? null,
      w.action ?? null,
      w.finisher ?? null,
      w.delegant ?? null,
      w.receiptor ?? null,
      w.comment ?? null,
      w.finishedAt ?? null,
      w.allowedAt ?? null,
    ],
  );
  return id;
}

async function closeWorkitem(
  client: PoolClient,
  id: string,
  fields: { state: string; approval?: string | null; action?: string | null; finisher?: string | null; comment?: string | null },
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE ${q(T.WORKFLOW_WORKITEMS)}
       SET state = $2, approval = $3, action = $4, finisher = $5, comment = $6, finished_at = $7
     WHERE id = $1`,
    [id, fields.state, fields.approval ?? null, fields.action ?? null, fields.finisher ?? null, fields.comment ?? null, now],
  );
}

async function cancelOpenWorkitems(client: PoolClient, stepId: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE ${q(T.WORKFLOW_WORKITEMS)} SET state = 'canceled', finished_at = $2 WHERE step_id = $1 AND state = 'active'`,
    [stepId, now],
  );
}

async function closeStep(
  client: PoolClient,
  id: string,
  state: string,
  approval: string | null,
  now: Date,
): Promise<void> {
  await client.query(`UPDATE ${q(T.WORKFLOW_STEPS)} SET state = $2, approval = $3, finished_at = $4 WHERE id = $1`, [
    id,
    state,
    approval,
    now,
  ]);
}

async function updateInstance(
  client: PoolClient,
  object: string,
  recordKey: string,
  sets: Record<string, unknown>,
): Promise<void> {
  const cols = Object.keys(sets);
  if (cols.length === 0) return;
  const setSql = cols.map((c, i) => `${q(c)} = $${i + 3}`).join(', ');
  await client.query(
    `UPDATE ${q(T.WORKFLOW_INSTANCES)} SET ${setSql} WHERE object = $1 AND record_key = $2`,
    [object, recordKey, ...cols.map((c) => sets[c])],
  );
}

async function mirrorSide(
  client: PoolClient,
  object: string,
  recordKey: string,
  state: string,
  actor: string,
  now: Date,
): Promise<void> {
  await upsertRecordMeta(client, object, recordKey, {
    status: SIDE_STATUS[state] ?? WEAVE_STATUS.RUNNING,
    workflowInstanceId: recordKey,
    modifiedBy: actor,
    modifiedTime: now,
  });
}

/** context threaded through node entry (mutable `prevStepId`) */
interface EnterCtx {
  def: WorkflowRuntimeOptions;
  recordKey: string;
  wf: WorkflowDefinition;
  now: Date;
  locale?: Locale;
  prevStepId: string | null;
}

/** create a node's step + workitems; `notify` nodes auto-advance. Returns the active step or `finished` */
async function enterNode(
  client: PoolClient,
  ctx: EnterCtx,
  nodeIndex: number,
): Promise<{ stepId: string; nodeId: string } | { finished: true }> {
  if (nodeIndex >= ctx.wf.nodes.length) return { finished: true };
  const node = ctx.wf.nodes[nodeIndex] as WorkflowNode;
  const kind = node.kind ?? 'approve';
  const stepId = await createStep(
    client,
    ctx.def.name,
    ctx.recordKey,
    node.id,
    kind,
    ctx.prevStepId,
    ctx.now,
  );
  ctx.prevStepId = stepId;
  const users = await resolveAssignees(client, node.assign.roles);

  if (kind === 'notify') {
    for (const participant of users) {
      await insertWorkitem(client, {
        object: ctx.def.name,
        recordKey: ctx.recordKey,
        stepId,
        nodeId: node.id,
        kind: 'cc',
        participant,
        state: 'done',
        action: 'notify',
        finishedAt: ctx.now,
      });
    }
    await closeStep(client, stepId, 'finished', null, ctx.now);
    return enterNode(client, ctx, nodeIndex + 1);
  }

  if (users.length === 0) {
    throw new SchemaError('workflow.assignee.none', { object: ctx.def.name, node: node.id }, ctx.locale);
  }
  const timeoutMs = node.onTimeout === undefined ? undefined : parseDuration(node.onTimeout.after);
  const allowedAt =
    timeoutMs === undefined || timeoutMs <= 0 ? null : new Date(ctx.now.getTime() + timeoutMs);
  for (const participant of users) {
    await insertWorkitem(client, {
      object: ctx.def.name,
      recordKey: ctx.recordKey,
      stepId,
      nodeId: node.id,
      kind: 'approve',
      participant,
      state: 'active',
      allowedAt,
    });
  }
  return { stepId, nodeId: node.id };
}

/** create the implicit start node's step (originator acts via `submit`) */
async function enterStart(client: PoolClient, ctx: EnterCtx): Promise<string> {
  const stepId = await createStep(client, ctx.def.name, ctx.recordKey, WORKFLOW_START_NODE, 'start', ctx.prevStepId, ctx.now);
  ctx.prevStepId = stepId;
  return stepId;
}

function nodeIndexOf(wf: WorkflowDefinition, nodeId: string): number {
  return wf.nodes.findIndex((n) => n.id === nodeId);
}

/** cancel/withdraw/cancel guard: nobody else may be actively viewing the record */
async function assertNoForeignLock(
  client: PoolClient,
  object: string,
  recordKey: string,
  requester: string,
  locale: Locale | undefined,
): Promise<void> {
  const res = await client.query(
    `SELECT holder FROM ${q(T.WORKFLOW_LOCKS)}
      WHERE object = $1 AND record_key = $2 AND expires_at > now() AND holder <> $3 LIMIT 1`,
    [object, recordKey, requester],
  );
  const row = res.rows[0] as { holder: string } | undefined;
  if (row !== undefined) {
    throw new SchemaError('workflow.withdraw.locked', { object, holder: row.holder }, locale);
  }
}

/** find the caller's open workitem (or undefined) */
function findMyWorkitem(items: WorkitemRow[], subject: IdentitySubject | undefined): WorkitemRow | undefined {
  if (subject === undefined) return undefined;
  return items.find((w) => w.kind === 'approve' && w.participant === subject.id);
}

/**
 * Run one workflow action within the caller's transaction. The instance row is
 * locked; steps/workitems are opened/closed accordingly. The side-table status
 * mirror is updated in the same transaction.
 */
export async function runWorkflowTransition(
  client: PoolClient,
  def: WorkflowRuntimeOptions,
  recordKey: string,
  action: string,
  subject: IdentitySubject | undefined,
  payload: Record<string, unknown> | undefined,
  locale: Locale | undefined,
): Promise<WorkflowTransitionOutcome> {
  const now = new Date();
  const actor = subject?.id ?? 'system';
  const inst = await loadInstance(client, def.name, recordKey);

  if (action === WORKFLOW_ACTIONS.SUBMIT) {
    const hash = def.workflowHash;
    if (def.workflow === undefined || def.workflow.nodes.length === 0 || hash === undefined) {
      throw new SchemaError('workflow.transition.unknown', { object: def.name, action }, locale);
    }
    let prevStepId: string | null = null;
    if (inst !== undefined && inst.state === 'running') {
      const step = await loadActiveStep(client, inst.current_step_id);
      if (step === undefined || step.node_id !== WORKFLOW_START_NODE) {
        throw new SchemaError('workflow.transition.notAllowed', { object: def.name, action }, locale);
      }
      await closeStep(client, step.id, 'finished', null, now);
      prevStepId = step.id;
    }
    await registerDefinition(client, def.name, hash, def.workflow);
    if (inst === undefined) {
      await client.query(
        `INSERT INTO ${q(T.WORKFLOW_INSTANCES)}
           (object, record_key, workflow_hash, state, current_step_id, originator, originator_parent, approval, created_at, started_at, activated_at)
         VALUES ($1,$2,$3,'running',NULL,$4,$5,NULL,$6,$6,$6)`,
        [def.name, recordKey, hash, actor, subject?.departmentId ?? null, now],
      );
    } else {
      await updateInstance(client, def.name, recordKey, {
        state: 'running',
        workflow_hash: hash,
        approval: null,
        started_at: inst.state === 'running' ? undefined : now,
        activated_at: now,
        finished_at: null,
      });
    }
    const ctx: EnterCtx = { def, recordKey, wf: def.workflow, now, locale, prevStepId };
    const entered = await enterNode(client, ctx, 0);
    if ('finished' in entered) {
      await updateInstance(client, def.name, recordKey, { state: 'finished', approval: 'approved', finished_at: now, current_step_id: null });
      await mirrorSide(client, def.name, recordKey, 'finished', actor, now);
      return { state: 'finished', fromNodeId: WORKFLOW_START_NODE };
    }
    await updateInstance(client, def.name, recordKey, { current_step_id: entered.stepId });
    await mirrorSide(client, def.name, recordKey, 'running', actor, now);
    return { state: 'running', nodeId: entered.nodeId, toNodeId: entered.nodeId, fromNodeId: WORKFLOW_START_NODE };
  }

  if (inst === undefined || inst.state !== 'running') {
    throw new SchemaError('workflow.transition.notAllowed', { object: def.name, action }, locale);
  }
  const wf = await resolveDefinition(client, def, inst.workflow_hash, locale);
  const step = await loadActiveStep(client, inst.current_step_id);
  if (step === undefined) {
    throw new SchemaError('workflow.transition.notAllowed', { object: def.name, action }, locale);
  }
  const node = wf.nodes.find((n) => n.id === step.node_id);
  const items = await loadOpenWorkitems(client, step.id);
  const mine = findMyWorkitem(items, subject);
  const isOriginator = subject !== undefined && subject.id === inst.originator;
  const enterCtx: EnterCtx = { def, recordKey, wf, now, locale, prevStepId: step.id };

  if (action === WORKFLOW_ACTIONS.APPROVE || action === WORKFLOW_ACTIONS.REJECT || action === WORKFLOW_ACTIONS.FORWARD) {
    if (subject !== undefined && mine === undefined) {
      throw new SchemaError('workflow.transition.denied', { object: def.name, role: subject.roles.join(','), action }, locale);
    }

    if (action === WORKFLOW_ACTIONS.FORWARD) {
      const to = (payload as { to?: { userId?: unknown } } | undefined)?.to?.userId;
      if (typeof to !== 'string' || to.length === 0 || mine === undefined) {
        throw new SchemaError('workflow.transition.unknown', { object: def.name, action }, locale);
      }
      await client.query(
        `UPDATE ${q(T.WORKFLOW_WORKITEMS)}
           SET state = 'transferred', action = 'forward', finisher = $2, delegant = $2, receiptor = $3, comment = $4, finished_at = $5
         WHERE id = $1`,
        [mine.id, actor, to, commentOf(payload), now],
      );
      const alreadyOpen = await client.query(
        `SELECT 1 FROM ${q(T.WORKFLOW_WORKITEMS)}
          WHERE step_id = $1 AND participant = $2 AND kind = 'approve' AND state = 'active' LIMIT 1`,
        [step.id, to],
      );
      if ((alreadyOpen.rowCount ?? 0) === 0) {
        await insertWorkitem(client, {
          object: def.name,
          recordKey,
          stepId: step.id,
          nodeId: step.node_id,
          kind: 'approve',
          participant: to,
          state: 'active',
          delegant: actor,
        });
      }
      return { state: 'running', nodeId: step.node_id, fromNodeId: step.node_id, toNodeId: step.node_id };
    }

    const approval = action === WORKFLOW_ACTIONS.APPROVE ? 'approved' : 'rejected';
    if (mine !== undefined) {
      await closeWorkitem(client, mine.id, { state: 'done', approval, action, finisher: actor, comment: commentOf(payload) }, now);
    }

    if (action === WORKFLOW_ACTIONS.REJECT) {
      await cancelOpenWorkitems(client, step.id, now);
      await closeStep(client, step.id, 'finished', 'rejected', now);
      return rollbackTo(client, enterCtx, node, step.id, WORKFLOW_ACTIONS.REJECT, actor, now);
    }

    // approve: evaluate the node quorum
    const mode = node?.assign.mode ?? 'any';
    const remaining = (await loadOpenWorkitems(client, step.id)).filter((w) => w.kind === 'approve');
    const quorumMet = mode === 'all' ? remaining.length === 0 : true;
    if (!quorumMet) {
      return { state: 'running', nodeId: step.node_id, fromNodeId: step.node_id, toNodeId: step.node_id };
    }
    await cancelOpenWorkitems(client, step.id, now);
    await closeStep(client, step.id, 'finished', 'approved', now);
    const idx = node === undefined ? wf.nodes.length : nodeIndexOf(wf, node.id);
    const entered = await enterNode(client, enterCtx, idx + 1);
    if ('finished' in entered) {
      await updateInstance(client, def.name, recordKey, { state: 'finished', approval: 'approved', finished_at: now, current_step_id: null });
      await mirrorSide(client, def.name, recordKey, 'finished', actor, now);
      return { state: 'finished', fromNodeId: step.node_id };
    }
    await updateInstance(client, def.name, recordKey, { current_step_id: entered.stepId });
    await mirrorSide(client, def.name, recordKey, 'running', actor, now);
    return { state: 'running', nodeId: entered.nodeId, fromNodeId: step.node_id, toNodeId: entered.nodeId };
  }

  if (action === WORKFLOW_ACTIONS.WITHDRAW || action === WORKFLOW_ACTIONS.CANCEL) {
    if (subject !== undefined && !isOriginator && mine === undefined) {
      throw new SchemaError('workflow.transition.denied', { object: def.name, role: subject.roles.join(','), action }, locale);
    }
    await assertNoForeignLock(client, def.name, recordKey, actor, locale);
    if (action === WORKFLOW_ACTIONS.CANCEL) {
      await cancelOpenWorkitems(client, step.id, now);
      await closeStep(client, step.id, 'canceled', 'canceled', now);
      await updateInstance(client, def.name, recordKey, { state: 'canceled', approval: 'rejected', finished_at: now, current_step_id: null });
      await mirrorSide(client, def.name, recordKey, 'canceled', actor, now);
      return { state: 'canceled', fromNodeId: step.node_id };
    }
    await cancelOpenWorkitems(client, step.id, now);
    await closeStep(client, step.id, 'finished', 'withdrawn', now);
    return rollbackTo(client, enterCtx, node, step.id, WORKFLOW_ACTIONS.WITHDRAW, actor, now);
  }

  throw new SchemaError('workflow.transition.unknown', { object: def.name, action }, locale);
}

/** roll back to a node (or the start node) after reject/withdraw */
async function rollbackTo(
  client: PoolClient,
  ctx: EnterCtx,
  node: WorkflowNode | undefined,
  fromStepId: string,
  action: string,
  actor: string,
  now: Date,
): Promise<WorkflowTransitionOutcome> {
  const targetId = (action === WORKFLOW_ACTIONS.REJECT ? node?.onReject : node?.onWithdraw) ?? undefined;
  if (targetId === undefined) {
    const stepId = await enterStart(client, ctx);
    await updateInstance(client, ctx.def.name, ctx.recordKey, { current_step_id: stepId, state: 'running' });
    await mirrorSide(client, ctx.def.name, ctx.recordKey, 'running', actor, now);
    return { state: 'running', nodeId: WORKFLOW_START_NODE, fromNodeId: node?.id, toNodeId: WORKFLOW_START_NODE };
  }
  const idx = nodeIndexOf(ctx.wf, targetId);
  const entered = await enterNode(client, ctx, idx);
  if ('finished' in entered) {
    await updateInstance(client, ctx.def.name, ctx.recordKey, { state: 'finished', finished_at: now, current_step_id: null });
    await mirrorSide(client, ctx.def.name, ctx.recordKey, 'finished', actor, now);
    return { state: 'finished', fromNodeId: node?.id };
  }
  await updateInstance(client, ctx.def.name, ctx.recordKey, { current_step_id: entered.stepId, state: 'running' });
  await mirrorSide(client, ctx.def.name, ctx.recordKey, 'running', actor, now);
  return { state: 'running', nodeId: entered.nodeId, fromNodeId: node?.id, toNodeId: entered.nodeId };
}

function commentOf(payload: Record<string, unknown> | undefined): string | null {
  const comment = payload?.comment;
  return typeof comment === 'string' && comment.length > 0 ? comment : null;
}

/** presence-lock TTL (seconds) — matches the frontend heartbeat convention */
export const WORKFLOW_LOCK_TTL_SECONDS = 60;

/** one open workitem of the current step, as seen by a caller */
export interface WorkflowWorkitemView {
  id: string;
  nodeId: string;
  kind: string;
  state: string;
  participant: string;
}

/** read-only workflow status for a record (GET …/workflow) */
export interface WorkflowStatus {
  state: 'draft' | 'running' | 'finished' | 'canceled';
  /** current node id (running only) */
  node?: string;
  approval?: string | null;
  /** actions available to the caller */
  actions: string[];
  /** the caller's open workitems on the current step */
  workitems: WorkflowWorkitemView[];
}

/**
 * Read a record's workflow status (no locking): instance state, current node
 * and the actions available to `subject`. Used by the REST/MCP read surface.
 */
export async function getWorkflowStatus(
  client: Pool | PoolClient,
  def: WorkflowRuntimeOptions,
  recordKey: string,
  subject: IdentitySubject | undefined,
): Promise<WorkflowStatus> {
  const instRes = await client.query(
    `SELECT state, approval, current_step_id, originator FROM ${q(T.WORKFLOW_INSTANCES)}
      WHERE object = $1 AND record_key = $2`,
    [def.name, recordKey],
  );
  const inst = instRes.rows[0] as
    | { state: string; approval: string | null; current_step_id: string | null; originator: string }
    | undefined;
  if (inst === undefined) {
    return { state: 'draft', actions: subject === undefined ? [] : [WORKFLOW_ACTIONS.SUBMIT], workitems: [] };
  }
  if (inst.state !== 'running') {
    return {
      state: inst.state as WorkflowStatus['state'],
      approval: inst.approval,
      actions: [],
      workitems: [],
    };
  }
  const stepRes = await client.query(
    `SELECT node_id, kind FROM ${q(T.WORKFLOW_STEPS)} WHERE id = $1`,
    [inst.current_step_id],
  );
  const step = stepRes.rows[0] as { node_id: string; kind: string } | undefined;
  const openRes = await client.query(
    `SELECT id, node_id, kind, state, participant FROM ${q(T.WORKFLOW_WORKITEMS)}
      WHERE step_id = $1 AND kind = 'approve' AND state = 'active'`,
    [inst.current_step_id],
  );
  const open = openRes.rows as WorkflowWorkitemView[];
  const mine = subject === undefined ? [] : open.filter((w) => w.participant === subject.id);
  const isOriginator = subject !== undefined && subject.id === inst.originator;
  const actions: string[] = [];
  if (subject !== undefined) {
    if (step?.node_id === WORKFLOW_START_NODE) {
      actions.push(WORKFLOW_ACTIONS.SUBMIT);
    } else {
      if (mine.length > 0) actions.push(WORKFLOW_ACTIONS.APPROVE, WORKFLOW_ACTIONS.REJECT, WORKFLOW_ACTIONS.FORWARD);
      if (mine.length > 0 || isOriginator) actions.push(WORKFLOW_ACTIONS.WITHDRAW);
    }
    if (isOriginator) actions.push(WORKFLOW_ACTIONS.CANCEL);
  }
  return {
    state: 'running',
    ...(step === undefined ? {} : { node: step.node_id }),
    approval: inst.approval,
    actions,
    workitems: mine,
  };
}

/** acquire/renew the caller's presence lock on the current step (TTL lease) */
export async function acquireWorkflowLock(
  client: Pool | PoolClient,
  def: WorkflowRuntimeOptions,
  recordKey: string,
  subject: IdentitySubject | undefined,
  locale: Locale | undefined,
): Promise<{ expiresAt: Date }> {
  if (subject === undefined) {
    throw new SchemaError('workflow.transition.denied', { object: def.name, role: '', action: 'lock' }, locale);
  }
  const instRes = await client.query(
    `SELECT current_step_id FROM ${q(T.WORKFLOW_INSTANCES)} WHERE object = $1 AND record_key = $2 AND state = 'running'`,
    [def.name, recordKey],
  );
  const stepId = (instRes.rows[0] as { current_step_id: string | null } | undefined)?.current_step_id ?? null;
  if (stepId === null) {
    throw new SchemaError('workflow.transition.notAllowed', { object: def.name, action: 'lock' }, locale);
  }
  const wi = await client.query(
    `SELECT id FROM ${q(T.WORKFLOW_WORKITEMS)}
      WHERE step_id = $1 AND participant = $2 AND kind = 'approve' AND state = 'active' LIMIT 1`,
    [stepId, subject.id],
  );
  const workitemId = (wi.rows[0] as { id: string } | undefined)?.id;
  if (workitemId === undefined) {
    throw new SchemaError('workflow.transition.denied', { object: def.name, role: subject.roles.join(','), action: 'lock' }, locale);
  }
  const res = await client.query(
    `INSERT INTO ${q(T.WORKFLOW_LOCKS)} (workitem_id, object, record_key, holder, acquired_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' seconds')::interval)
     ON CONFLICT (workitem_id) DO UPDATE SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
     RETURNING expires_at`,
    [workitemId, def.name, recordKey, subject.id, String(WORKFLOW_LOCK_TTL_SECONDS)],
  );
  return { expiresAt: (res.rows[0] as { expires_at: Date }).expires_at };
}

/** release the caller's presence lock (and drop any expired locks for the record) */
export async function releaseWorkflowLock(
  client: Pool | PoolClient,
  def: WorkflowRuntimeOptions,
  recordKey: string,
  subject: IdentitySubject | undefined,
): Promise<void> {
  await client.query(`DELETE FROM ${q(T.WORKFLOW_LOCKS)} WHERE object = $1 AND record_key = $2 AND (holder = $3 OR expires_at <= now())`, [
    def.name,
    recordKey,
    subject?.id ?? '',
  ]);
}


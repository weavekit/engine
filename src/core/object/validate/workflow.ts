import {
  WORKFLOW_ASSIGN_MODES,
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_TIMEOUT_ACTIONS,
  parseDuration,
} from '../../types/workflow.js';
import type {
  WorkflowAssign,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowTimeout,
  WorkflowTimeoutAction,
} from '../../types/workflow.js';
import { validateLabels } from './labels.js';
import { fail, isRecord, SNAKE_CASE, type Vc } from './primitives.js';

/** validate a node's `assign` block (roles required, mode optional) */
function validateAssign(raw: unknown, kind: WorkflowNodeKind | undefined, vc: Vc, i: number): WorkflowAssign {
  if (!isRecord(raw)) fail(vc, 'workflow.node.invalid', { i, value: 'assign' });
  const rolesRaw = raw.roles;
  if (
    !Array.isArray(rolesRaw) ||
    rolesRaw.length === 0 ||
    !rolesRaw.every((role) => typeof role === 'string' && role.length > 0)
  ) {
    fail(vc, 'workflow.node.invalid', { i, value: 'assign.roles' });
  }
  let mode: WorkflowAssign['mode'];
  if (raw.mode !== undefined) {
    if (raw.mode !== WORKFLOW_ASSIGN_MODES.ANY && raw.mode !== WORKFLOW_ASSIGN_MODES.ALL) {
      fail(vc, 'workflow.node.invalid', { i, value: 'assign.mode' });
    }
    mode = raw.mode;
  }
  // a notify (抄送) node never gates, so 会签 is meaningless there
  if (kind === WORKFLOW_NODE_KINDS.NOTIFY && mode === WORKFLOW_ASSIGN_MODES.ALL) {
    fail(vc, 'workflow.node.invalid', { i, value: 'assign.mode' });
  }
  return { roles: rolesRaw as string[], ...(mode === undefined ? {} : { mode }) };
}

/**
 * Validate a declared single-line node-chain workflow (`objects/<name>/workflow.json`).
 * Self-contained: nodes are unique snake_case ids; `onReject`/`onWithdraw` must
 * reference an **earlier** node; every node carries a non-empty `assign.roles`.
 * Returns `undefined` when no workflow is declared.
 */
export function validateWorkflow(raw: unknown, vc: Vc): WorkflowDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'workflow.notObject');

  // on-disk format version (fail-closed on unknown/future versions)
  let schemaVersion: number | undefined;
  const rawVersion = raw.schemaVersion;
  if (rawVersion !== undefined) {
    if (
      typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1 ||
      rawVersion > WORKFLOW_FORMAT_VERSION
    ) {
      fail(vc, 'schema.version.unsupported', {
        version: String(rawVersion),
        supported: WORKFLOW_FORMAT_VERSION,
      });
    }
    schemaVersion = rawVersion;
  }

  // author-managed definition revision (optional positive integer)
  let version: number | undefined;
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
      fail(vc, 'workflow.version.invalid');
    }
    version = raw.version;
  }

  // nodes: non-empty, unique snake_case ids; rollback targets must be earlier
  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) fail(vc, 'workflow.nodes.required');
  const nodes: WorkflowNode[] = [];
  const priorIds = new Set<string>();
  rawNodes.forEach((entry, index) => {
    const i = index + 1;
    if (!isRecord(entry)) fail(vc, 'workflow.node.invalid', { i, value: String(entry) });
    const id = entry.id;
    if (typeof id !== 'string' || !SNAKE_CASE.test(id) || priorIds.has(id)) {
      fail(vc, 'workflow.node.invalid', { i, value: String(id) });
    }

    let kind: WorkflowNodeKind | undefined;
    if (entry.kind !== undefined) {
      if (entry.kind !== WORKFLOW_NODE_KINDS.APPROVE && entry.kind !== WORKFLOW_NODE_KINDS.NOTIFY) {
        fail(vc, 'workflow.node.invalid', { i, value: String(entry.kind) });
      }
      kind = entry.kind;
    }

    const name = validateLabels(entry.name, vc);
    const description = entry.description === undefined ? undefined : String(entry.description);
    const assign = validateAssign(entry.assign, kind, vc, i);

    let requiresApproval: boolean | undefined;
    if (entry.requiresApproval !== undefined) {
      if (typeof entry.requiresApproval !== 'boolean') {
        fail(vc, 'workflow.node.invalid', { i, value: 'requiresApproval' });
      }
      requiresApproval = entry.requiresApproval;
    }

    // rollback targets must name an earlier node in the chain
    const rollbackTarget = (value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string' || !priorIds.has(value)) {
        fail(vc, 'workflow.rollback.notEarlier', { i, value: String(value) });
      }
      return value;
    };
    const onReject = rollbackTarget(entry.onReject);
    const onWithdraw = rollbackTarget(entry.onWithdraw);

    let onTimeout: WorkflowTimeout | undefined;
    if (entry.onTimeout !== undefined) {
      if (kind === WORKFLOW_NODE_KINDS.NOTIFY) fail(vc, 'workflow.timeout.invalid', { state: id });
      const rawTimeout = entry.onTimeout;
      if (!isRecord(rawTimeout)) fail(vc, 'workflow.timeout.invalid', { state: id });
      const after = rawTimeout.after;
      if (typeof after !== 'string' || parseDuration(after) === undefined) {
        fail(vc, 'workflow.timeout.invalid', { state: id });
      }
      let timeoutAction: WorkflowTimeoutAction | undefined;
      if (rawTimeout.action !== undefined) {
        if (
          rawTimeout.action !== WORKFLOW_TIMEOUT_ACTIONS.APPROVE &&
          rawTimeout.action !== WORKFLOW_TIMEOUT_ACTIONS.REJECT
        ) {
          fail(vc, 'workflow.timeout.invalid', { state: id });
        }
        timeoutAction = rawTimeout.action;
      }
      onTimeout = { after, ...(timeoutAction === undefined ? {} : { action: timeoutAction }) };
    }

    priorIds.add(id);
    nodes.push({
      id,
      ...(kind === undefined ? {} : { kind }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      assign,
      ...(onReject === undefined ? {} : { onReject }),
      ...(onWithdraw === undefined ? {} : { onWithdraw }),
      ...(requiresApproval === undefined ? {} : { requiresApproval }),
      ...(onTimeout === undefined ? {} : { onTimeout }),
    });
  });

  return {
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(version === undefined ? {} : { version }),
    nodes,
  };
}

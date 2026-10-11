import type { ApprovalListFilter, ApprovalStatus, ToolApprovals } from '../../core/index.js';
import { APPROVAL_STATUSES, APPROVAL_TOOLS, SchemaError } from '../../core/index.js';
import { callProtected, textResult } from './tools.js';
import type { McpToolResult, ToolExecContext } from './types.js';

/**
 * Approval-queue MCP tools (`list_approvals` / `approve_approval` /
 * `reject_approval`). They mirror the REST `/approvals` routes: admin-gated
 * (the queue carries request arguments) and backed by the same injected
 * `ToolApprovals` queue — resolution is audited by the queue facade, the tool
 * call itself is audited here via `callProtected`.
 */

const VALID_STATUSES = new Set<string>(Object.values(APPROVAL_STATUSES));

/**
 * Fail-closed gate: the queue must be wired and the caller must carry a role
 * listed in `adminRoles`. The compiled surface already filters to admins; this
 * re-check is the execution-layer double (mirrors the object-RBAC double layer).
 */
function requireApprovals(ctx: ToolExecContext): ToolApprovals {
  const approvals = ctx.engine.approvals;
  const admin = new Set(ctx.engine.adminRoles ?? []);
  if (approvals === undefined || !ctx.session.user.roles.some((role) => admin.has(role))) {
    throw new SchemaError(
      'rbac.denied.update',
      { object: 'approvals', role: ctx.session.user.roles.join(',') },
      ctx.engine.locale,
    );
  }
  return approvals;
}

function parseFilter(args: Record<string, unknown>, ctx: ToolExecContext): ApprovalListFilter {
  const filter: ApprovalListFilter = {};
  const status = args.status;
  if (status !== undefined) {
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      throw new SchemaError('http.param.invalid', { param: 'status' }, ctx.engine.locale);
    }
    filter.status = status as ApprovalStatus;
  }
  if (typeof args.action === 'string') filter.action = args.action;
  if (typeof args.actorKey === 'string') filter.actorKey = args.actorKey;
  if (typeof args.limit === 'number') filter.limit = args.limit;
  if (typeof args.offset === 'number') filter.offset = args.offset;
  return filter;
}

export async function listApprovalsHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  return callProtected(ctx, APPROVAL_TOOLS.LIST, undefined, args, async () => ctx.session.user, async () => {
    const approvals = requireApprovals(ctx);
    const filter = parseFilter(args, ctx);
    const [rows, total] = await Promise.all([approvals.list(filter), approvals.count(filter)]);
    return textResult(JSON.stringify({ rows, total }));
  });
}

async function resolveApproval(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
  decision: 'approved' | 'rejected',
): Promise<McpToolResult> {
  const tool = decision === 'approved' ? APPROVAL_TOOLS.APPROVE : APPROVAL_TOOLS.REJECT;
  return callProtected(ctx, tool, undefined, args, async () => ctx.session.user, async (subject) => {
    const approvals = requireApprovals(ctx);
    const key = String(args.key ?? '');
    const ok =
      decision === 'approved' ? await approvals.approve(key, subject.id) : await approvals.reject(key, subject.id);
    if (!ok) {
      throw new SchemaError('approval.notFound', { approvalKey: key }, ctx.engine.locale);
    }
    return textResult(JSON.stringify({ approvalKey: key, status: decision, approver: subject.id }));
  });
}

export async function approveApprovalHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  return resolveApproval(args, ctx, 'approved');
}

export async function rejectApprovalHandler(
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<McpToolResult> {
  return resolveApproval(args, ctx, 'rejected');
}

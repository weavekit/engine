import type { ApprovalPolicySnapshot } from '@weave-kit/contract';

export const APPROVAL_EVENT_TYPES = {
  REQUESTED: 'approval.requested',
  VOTE: 'approval.vote',
  QUORUM_REACHED: 'approval.quorumReached',
  APPROVED: 'approval.approved',
  REJECTED: 'approval.rejected',
  EXPIRED: 'approval.expired',
  CONSUMED: 'approval.consumed',
  DENIED: 'approval.denied',
} as const;
export type ApprovalEventType = typeof APPROVAL_EVENT_TYPES[keyof typeof APPROVAL_EVENT_TYPES];

/** Protocol-agnostic approval lifecycle event consumed by enterprise notifiers. */
export interface ApprovalEvent {
  type: ApprovalEventType;
  approvalKey: string;
  action: string;
  /** requester's actor key */
  actorKey: string;
  requestedBy?: string;
  onBehalfOf?: string;
  actorLabel?: string;
  /** approver/admin that decided or consumed (when applicable) */
  approver?: string;
  requestId?: string;
  policy?: ApprovalPolicySnapshot;
  requiredApprovals?: number;
  approvedCount?: number;
  approverRoles?: string[];
  approverGroups?: string[];
  expiresAt?: Date;
  consumedAt?: Date;
  resolvedAt?: Date;
  comment?: string;
  reason?: string;
  occurredAt: Date;
}

/** Optional sink; delivery failures must not break the approval path. */
export interface ApprovalEventSink {
  emit(event: ApprovalEvent): Promise<void> | void;
}

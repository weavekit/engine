import type { ApprovalListFilter, ApprovalVote, ApprovalsBackend, PendingApproval } from './types.js';

type EligibilityFilter = ApprovalListFilter & {
  pendingForRoles?: string[];
  pendingForGroups?: string[];
};

/**
 * In-memory `ApprovalsBackend` (tests / single-process default). Pure core —
 * no I/O, keeps "disabled = not imported = zero overhead" for the persisted
 * route. Honors the full `ApprovalListFilter` plus quorum voting.
 */
export function createMemoryApprovalsBackend(): ApprovalsBackend {
  const store = new Map<string, PendingApproval>();
  const votes = new Map<string, ApprovalVote[]>();

  const matches = (entry: PendingApproval, filter: EligibilityFilter): boolean => {
    if (filter.status !== undefined && entry.status !== filter.status) return false;
    if (filter.action !== undefined && entry.action !== filter.action) return false;
    if (filter.actorKey !== undefined && entry.actorKey !== filter.actorKey) return false;
    if (filter.requestedBy !== undefined && entry.requestedBy !== filter.requestedBy) return false;
    if (filter.approvalKey !== undefined && entry.approvalKey !== filter.approvalKey) return false;
    if (filter.pendingFor !== undefined) {
      if (entry.status !== 'pending' || entry.requestedBy === filter.pendingFor) return false;
      if (filter.pendingForRoles !== undefined || filter.pendingForGroups !== undefined) {
        const roles = filter.pendingForRoles ?? [];
        const groups = filter.pendingForGroups ?? [];
        const roleMatch = (entry.approverRoles ?? []).some((role) => roles.includes(role));
        const groupMatch = (entry.approverGroups ?? []).some((group) => groups.includes(group));
        const unrestricted =
          (entry.approverRoles ?? []).length === 0 && (entry.approverGroups ?? []).length === 0;
        const escalated =
          entry.escalatedAt !== undefined &&
          (entry.escalationApprovers ?? []).includes(filter.pendingFor);
        if (!roleMatch && !groupMatch && !unrestricted && !escalated) return false;
      }
    }
    if (filter.from !== undefined && entry.createdAt < filter.from) return false;
    if (filter.to !== undefined && entry.createdAt > filter.to) return false;
    if (filter.expiresBefore !== undefined) {
      if (entry.expiresAt === undefined || entry.expiresAt >= filter.expiresBefore) return false;
    }
    return true;
  };

  const applyVote = (entry: PendingApproval, vote: ApprovalVote): PendingApproval => {
    const list = votes.get(entry.approvalKey) ?? [];
    const approvedCount = list.filter((item) => item.decision === 'approved').length;
    if (vote.decision === 'rejected') {
      return {
        ...entry,
        status: 'rejected',
        approvedBy: vote.approver,
        rejectedBy: vote.approver,
        resolvedAt: vote.createdAt,
        approvedCount,
        ...(vote.comment === undefined ? {} : { comment: vote.comment }),
      };
    }
    if (approvedCount >= (entry.requiredApprovals ?? 1)) {
      return {
        ...entry,
        status: 'approved',
        approvedBy: vote.approver,
        resolvedAt: vote.createdAt,
        approvedCount,
        ...(vote.comment === undefined ? {} : { comment: vote.comment }),
      };
    }
    return { ...entry, approvedCount };
  };

  return {
    async list(filter = {}): Promise<PendingApproval[]> {
      const entries = [...store.values()].filter((entry) => matches(entry, filter));
      const field = filter.sort?.field ?? 'createdAt';
      const order = filter.sort?.order === 'DESC' ? -1 : 1;
      entries.sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        if (av === bv) return 0;
        if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * order;
        return String(av).localeCompare(String(bv)) * order;
      });
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? 100;
      return entries.slice(offset, offset + limit);
    },
    async get(approvalKey: string): Promise<PendingApproval | undefined> {
      return store.get(approvalKey);
    },
    async upsert(entry: PendingApproval): Promise<void> {
      if (!store.has(entry.approvalKey)) {
        store.set(entry.approvalKey, { ...entry, approvedCount: entry.approvedCount ?? 0 });
      }
    },
    async resolve(
      approvalKey: string,
      by: string,
      status: 'approved' | 'rejected',
      comment?: string,
    ): Promise<boolean> {
      const entry = store.get(approvalKey);
      if (entry === undefined || entry.status !== 'pending') return false;
      if (entry.expiresAt !== undefined && entry.expiresAt.getTime() <= Date.now()) return false;
      store.set(approvalKey, {
        ...entry,
        status,
        approvedBy: by,
        ...(status === 'rejected' ? { rejectedBy: by } : {}),
        resolvedAt: new Date(),
        ...(comment === undefined ? {} : { comment }),
      });
      return true;
    },
    async vote(approvalKey: string, vote: ApprovalVote): Promise<boolean> {
      const entry = store.get(approvalKey);
      if (entry === undefined || entry.status !== 'pending') return false;
      if (entry.expiresAt !== undefined && entry.expiresAt.getTime() <= Date.now()) return false;
      if (entry.requestedBy !== undefined && entry.requestedBy === vote.approver) return false;
      const list = votes.get(approvalKey) ?? [];
      const existing = list.find((item) => item.approver === vote.approver);
      if (existing !== undefined) return existing.decision === vote.decision;
      const recorded: ApprovalVote = { ...vote, stage: vote.stage ?? 0 };
      list.push(recorded);
      votes.set(approvalKey, list);
      store.set(approvalKey, applyVote(entry, recorded));
      return true;
    },
    async votes(approvalKey: string): Promise<ApprovalVote[]> {
      return [...(votes.get(approvalKey) ?? [])];
    },
    async consume(approvalKey: string, by: string): Promise<boolean> {
      const entry = store.get(approvalKey);
      if (entry === undefined || entry.status !== 'approved' || entry.consumedAt !== undefined) return false;
      store.set(approvalKey, { ...entry, consumedAt: new Date() });
      void by;
      return true;
    },
    async count(filter = {}): Promise<number> {
      return [...store.values()].filter((entry) => matches(entry, filter)).length;
    },
  };
}

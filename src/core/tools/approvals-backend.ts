import type { ApprovalListFilter, ApprovalsBackend, PendingApproval } from './types.js';

/**
 * In-memory `ApprovalsBackend` (tests / single-process default). Pure core —
 * no I/O, keeps "disabled = not imported = zero overhead" for the persisted
 * route. Honors the full `ApprovalListFilter` (status/action/actorKey/from/to/
 * limit/offset/sort) so it behaves like the PG store for unit tests.
 */
export function createMemoryApprovalsBackend(): ApprovalsBackend {
  const store = new Map<string, PendingApproval>();

  const matches = (entry: PendingApproval, filter: ApprovalListFilter): boolean => {
    if (filter.status !== undefined && entry.status !== filter.status) return false;
    if (filter.action !== undefined && entry.action !== filter.action) return false;
    if (filter.actorKey !== undefined && entry.actorKey !== filter.actorKey) return false;
    if (filter.from !== undefined && entry.createdAt < filter.from) return false;
    if (filter.to !== undefined && entry.createdAt > filter.to) return false;
    return true;
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
      store.set(entry.approvalKey, entry);
    },
    async resolve(approvalKey: string, by: string, status: 'approved' | 'rejected'): Promise<boolean> {
      const entry = store.get(approvalKey);
      if (entry === undefined || entry.status !== 'pending') return false;
      store.set(approvalKey, { ...entry, status, approvedBy: by });
      return true;
    },
    async count(filter = {}): Promise<number> {
      return [...store.values()].filter((entry) => matches(entry, filter)).length;
    },
  };
}

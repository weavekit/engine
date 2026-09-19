import type { Pool } from 'pg';
import type { ApprovalsBackend } from '../../core/tools/index.js';
import { createApprovalsPgStore, ensureApprovalsTable } from './store.js';

export { createApprovalsPgStore, ensureApprovalsTable } from './store.js';
export type { ApprovalListFilter, ApprovalStatus, ApprovalsBackend, PendingApproval } from '../../core/tools/index.js';

/**
 * Create the PG-backed `ApprovalsBackend` (D1 release default) and ensure the
 * `weavekit_approvals` table exists. Injected into the tool executor by the
 * engine assembly layer (P3). No Redis backend is implemented.
 */
export async function createApprovalsBackend(pool: Pool): Promise<ApprovalsBackend> {
  await ensureApprovalsTable(pool);
  return createApprovalsPgStore(pool);
}

import type { Pool } from 'pg';
import type { ApprovalsBackend } from '../../core/tools/index.js';
import { createApprovalsPgStore } from './store.js';

export { createApprovalsPgStore } from './store.js';
export type { ApprovalListFilter, ApprovalStatus, ApprovalsBackend, PendingApproval } from '../../core/tools/index.js';

/**
 * Create the PG-backed `ApprovalsBackend` (the release default). The
 * `weavekit_approvals` table is provisioned by `weave migrate`. Injected into
 * the tool executor by the engine assembly layer. No Redis backend is implemented.
 */
export async function createApprovalsBackend(pool: Pool): Promise<ApprovalsBackend> {
  return createApprovalsPgStore(pool);
}

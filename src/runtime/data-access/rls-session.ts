import type { PoolClient } from 'pg';
import { sqlIdent } from '../../core/index.js';

/** the subject attributes carried to RLS policies via the `weavekit.*` GUCs */
export interface RlsSubject {
  id: string;
  roles: readonly string[];
  departmentId?: string;
  scopeId?: string;
}

/**
 * Set the subject GUCs for the current transaction. Every GUC is set (absent →
 * `''`, which policies read as unset → fail-closed), so a value left by an
 * earlier statement in the same transaction never leaks into this one. The row
 * scope goes to both `weavekit.scope_id` and the `weavekit.scope_id` alias.
 */
export async function setRlsSubject(client: PoolClient, subject: RlsSubject): Promise<void> {
  await client.query(
    `SELECT set_config('weavekit.actor_id', $1, true), set_config('weavekit.roles', $2, true),
            set_config('weavekit.department_id', $3, true), set_config('weavekit.scope_id', $4, true)`,
    [subject.id, subject.roles.join(','), subject.departmentId ?? '', subject.scopeId ?? ''],
  );
}

/**
 * Run `fn` under `SET LOCAL ROLE <role>` with the subject GUCs set. The caller
 * must hold an open transaction (SET LOCAL is a no-op outside one); the role is
 * reset afterwards so later statements in the transaction run as the owner.
 * `role` must already be validated (`isSafeRlsRole`).
 */
export async function asRlsRole<R>(client: PoolClient, role: string, subject: RlsSubject, fn: () => Promise<R>): Promise<R> {
  await setRlsSubject(client, subject);
  await client.query(`SET LOCAL ROLE ${sqlIdent(role)}`);
  try {
    return await fn();
  } finally {
    // an aborted transaction rejects RESET; its rollback reverts the role anyway
    await client.query('RESET ROLE').catch(() => {});
  }
}

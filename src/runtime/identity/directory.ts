import type { IdentityDirectory, IdentityStore, IdentitySubject } from '../../core/provider/identity/index.js';

/**
 * Default `IdentityDirectory`: resolves an internal id or external id into the
 * `IdentitySubject` RBAC runs against, backed by the local `IdentityStore`.
 * Unknown or disabled users resolve to null (callers reject — fail-closed).
 */
export class PgIdentityDirectory implements IdentityDirectory {
  constructor(private readonly store: IdentityStore) {}

  async resolve(ref: string): Promise<IdentitySubject | null> {
    const user = await this.store.findUser(ref);
    if (user === null || user.enabled === false) return null;
    return {
      id: user.id,
      roles: user.roles,
      ...(user.departmentId === null ? {} : { departmentId: user.departmentId }),
    };
  }
}

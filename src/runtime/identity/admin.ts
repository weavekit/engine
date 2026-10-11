import type {
  IdentityDepartmentCreate,
  IdentityDepartmentRow,
  IdentityStore,
  IdentityUserCreate,
  IdentityUserRow,
} from '../../core/provider/identity/index.js';

/**
 * Greenfield identity administration: manage engine-owned users/departments
 * directly (`weavekit_user`/`weavekit_department`), for projects with no external
 * identity source. Imported (source-managed) users are provisioned via
 * `weave sync:identity` instead; `setEnabled`/`setRoles` work for both.
 */
export class IdentityAdmin {
  constructor(private readonly store: IdentityStore) {}

  list(): Promise<IdentityUserRow[]> {
    return this.store.listUsers();
  }

  create(input: IdentityUserCreate): Promise<{ id: string }> {
    return this.store.createUser(input);
  }

  /** enable/disable a user; false when the id is unknown */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const user = await this.store.findUser(id);
    if (user === null) return false;
    await this.store.setEnabled('user', user.id, enabled);
    return true;
  }

  /** replace a user's roles; false when the id is unknown */
  async setRoles(id: string, roles: string[]): Promise<boolean> {
    const user = await this.store.findUser(id);
    if (user === null) return false;
    return this.store.updateUserRoles(user.id, roles);
  }

  /** delete a user; false when the id is unknown */
  async remove(id: string): Promise<boolean> {
    const user = await this.store.findUser(id);
    if (user === null) return false;
    return this.store.deleteUser(user.id);
  }

  listDepartments(): Promise<IdentityDepartmentRow[]> {
    return this.store.listDepartments();
  }

  createDepartment(input: IdentityDepartmentCreate): Promise<{ id: string }> {
    return this.store.createDepartment(input);
  }
}

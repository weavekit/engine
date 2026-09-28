import type {
  IdentityStore,
  IdentityUserCreate,
  IdentityUserRow,
} from '../../core/provider/identity/index.js';

/**
 * Greenfield identity administration: manage engine-owned users directly
 * (`weavekit_user`), for projects with no external identity source. Imported
 * (source-managed) users are provisioned via `weave sync:identity` instead;
 * `setEnabled` works for both.
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
}

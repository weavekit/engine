import { describe, it, expect } from '../helpers/test.js';
import type {
  IdentityDepartmentRow,
  IdentityDepartmentInput,
  IdentityStore,
  IdentityUserInput,
  IdentityUserRow,
} from '../../src/core/provider/identity/index.js';
import { createFunctionIdentitySource, runIdentitySync } from '../../src/runtime/identity/index.js';

/** in-memory IdentityStore for exercising the sync engine without PG */
function memoryStore(): IdentityStore & { users: Map<string, IdentityUserRow>; depts: Map<string, IdentityDepartmentRow> } {
  const users = new Map<string, IdentityUserRow>();
  const depts = new Map<string, IdentityDepartmentRow>();
  const cursors = new Map<string, string>();
  const key = (s: string, e: string) => `${s}::${e}`;
  let seq = 0;
  const nextId = () => `id-${++seq}`;
  return {
    users,
    depts,
    async findUser(ref) {
      for (const r of users.values()) if (r.id === ref || r.externalId === ref) return r;
      return null;
    },
    async findUserByExternal(s, e) {
      return users.get(key(s, e)) ?? null;
    },
    async findDepartmentByExternal(s, e) {
      return depts.get(key(s, e)) ?? null;
    },
    async listExternalIds(s) {
      return {
        users: [...users.values()].filter((u) => u.externalSource === s && u.externalId !== null).map((u) => u.externalId!),
        departments: [...depts.values()].filter((d) => d.externalSource === s && d.externalId !== null).map((d) => d.externalId!),
      };
    },
    async upsertUser(input: IdentityUserInput) {
      const k = key(input.externalSource, input.externalId);
      const prev = users.get(k);
      const row: IdentityUserRow = {
        id: prev?.id ?? nextId(),
        externalSource: input.externalSource,
        externalId: input.externalId,
        roles: input.roles ?? [],
        departmentId: input.departmentId ?? null,
        directorId: input.directorId ?? null,
        enabled: input.enabled ?? null,
      };
      users.set(k, row);
      return { id: row.id };
    },
    async upsertDepartment(input: IdentityDepartmentInput) {
      const k = key(input.externalSource, input.externalId);
      const prev = depts.get(k);
      const row: IdentityDepartmentRow = {
        id: prev?.id ?? nextId(),
        externalSource: input.externalSource,
        externalId: input.externalId,
        parentId: input.parentId ?? null,
        managerId: input.managerId ?? null,
        enabled: input.enabled ?? null,
      };
      depts.set(k, row);
      return { id: row.id };
    },
    async setEnabled(kind, id, enabled) {
      const map: Map<string, { id: string; enabled: boolean | null }> = kind === 'user' ? users : depts;
      for (const row of map.values()) if (row.id === id) row.enabled = enabled;
    },
    async getCursor(s) {
      return cursors.get(s) ?? null;
    },
    async setCursor(s, c) {
      cursors.set(s, c);
    },
  };
}

describe('identity sync engine', () => {
  it('upserts users/departments and links parent/director/manager (order-independent)', async () => {
    const store = memoryStore();
    const source = createFunctionIdentitySource({
      name: 'crm',
      pull: () => ({
        // departments listed child-first on purpose
        departments: [
          { externalId: 'd2', name: 'East', parentExternalId: 'd1', managerExternalId: 'a' },
          { externalId: 'd1', name: 'Sales' },
        ],
        users: [
          { externalId: 'a', name: 'Alice', email: 'a@x', roles: ['admin', 'sales'], departmentExternalId: 'd1', directorExternalId: 'b' },
          { externalId: 'b', name: 'Bob', roles: ['sales'], departmentExternalId: 'd2' },
        ],
      }),
    });
    const summary = await runIdentitySync(source, store);
    expect(summary.users).toEqual({ created: 2, updated: 0, disabled: 0 });
    expect(summary.departments).toEqual({ created: 2, updated: 0, disabled: 0 });

    const d1 = (await store.findDepartmentByExternal('crm', 'd1'))!;
    const d2 = (await store.findDepartmentByExternal('crm', 'd2'))!;
    const a = (await store.findUserByExternal('crm', 'a'))!;
    const b = (await store.findUserByExternal('crm', 'b'))!;
    expect(d2.parentId).toBe(d1.id);
    expect(d2.managerId).toBe(a.id);
    expect(a.departmentId).toBe(d1.id);
    expect(a.directorId).toBe(b.id);
    expect(a.roles).toEqual(['admin', 'sales']);
  });

  it('is idempotent: a second pull updates but creates nothing', async () => {
    const store = memoryStore();
    const pull = () => ({
      users: [{ externalId: 'a', name: 'Alice' }],
      departments: [{ externalId: 'd1', name: 'Sales' }],
    });
    const source = createFunctionIdentitySource({ name: 'crm', pull });
    await runIdentitySync(source, store);
    const again = await runIdentitySync(source, store);
    expect(again.users).toEqual({ created: 0, updated: 1, disabled: 0 });
    expect(again.departments).toEqual({ created: 0, updated: 1, disabled: 0 });
  });

  it('soft-disables rows missing from the snapshot (never deletes)', async () => {
    const store = memoryStore();
    let present = ['a', 'b'];
    const source = createFunctionIdentitySource({
      name: 'crm',
      pull: () => ({ users: present.map((e) => ({ externalId: e })), departments: [] }),
    });
    await runIdentitySync(source, store, { deactivateMissing: true });
    present = ['a'];
    const summary = await runIdentitySync(source, store, { deactivateMissing: true });
    expect(summary.users.disabled).toBe(1);
    expect((await store.findUserByExternal('crm', 'b'))?.enabled).toBe(false);
    // still present locally (not deleted)
    expect(await store.findUserByExternal('crm', 'b')).not.toBeNull();
  });

  it('detects a department parent cycle, warns, and drops the offending link', async () => {
    const store = memoryStore();
    const source = createFunctionIdentitySource({
      name: 'crm',
      pull: () => ({
        users: [],
        departments: [
          { externalId: 'd1', parentExternalId: 'd2' },
          { externalId: 'd2', parentExternalId: 'd1' },
        ],
      }),
    });
    const summary = await runIdentitySync(source, store);
    expect(summary.warnings.some((w) => w.includes('cycle'))).toBe(true);
    expect((await store.findDepartmentByExternal('crm', 'd1'))?.parentId).toBeNull();
    expect((await store.findDepartmentByExternal('crm', 'd2'))?.parentId).toBeNull();
  });

  it('dry-run reports counts without touching the store', async () => {
    const store = memoryStore();
    const source = createFunctionIdentitySource({
      name: 'crm',
      pull: () => ({ users: [{ externalId: 'a' }], departments: [{ externalId: 'd1' }] }),
    });
    const summary = await runIdentitySync(source, store, { dryRun: true });
    expect(summary.users.created).toBe(1);
    expect(summary.departments.created).toBe(1);
    expect(store.users.size).toBe(0);
    expect(store.depts.size).toBe(0);
  });

  it('persists and replays the incremental cursor', async () => {
    const store = memoryStore();
    let seenCursor: string | undefined;
    const source = createFunctionIdentitySource({
      name: 'crm',
      pull: (cursor) => {
        seenCursor = cursor;
        return { users: [], departments: [], cursor: 'v2' };
      },
    });
    await runIdentitySync(source, store);
    expect(seenCursor).toBeUndefined();
    await runIdentitySync(source, store);
    expect(seenCursor).toBe('v2');
  });
});

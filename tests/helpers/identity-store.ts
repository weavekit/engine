import type {
  IdentityDepartmentInput,
  IdentityDepartmentRow,
  IdentityStore,
  IdentityUserInput,
  IdentityUserRow,
} from '../../src/core/provider/identity/index.js';

/**
 * In-memory {@link IdentityStore} for exercising the sync engine / identity
 * routes without PostgreSQL.
 */
export function memoryIdentityStore(): IdentityStore & {
  users: Map<string, IdentityUserRow>;
  depts: Map<string, IdentityDepartmentRow>;
} {
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
    async createUser(input) {
      const id = nextId();
      users.set(`local::${id}`, {
        id,
        externalSource: null,
        externalId: null,
        roles: input.roles ?? [],
        departmentId: input.departmentId ?? null,
        directorId: input.directorId ?? null,
        enabled: input.enabled ?? null,
      });
      return { id };
    },
    async listUsers() {
      return [...users.values()];
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

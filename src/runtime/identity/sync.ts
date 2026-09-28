import type { IdentitySource, IdentityStore } from '../../core/provider/identity/index.js';

/**
 * Sync engine: pull a normalized snapshot from an {@link IdentitySource} and
 * upsert it into the local directory (the engine's identity store).
 *
 * Guarantees:
 *  - idempotent (upsert on `(source, external_id)`), create-then-link in two
 *    passes so a child may reference a parent/user listed later;
 *  - department parent cycles are detected and the offending edge is dropped
 *    (warned, never fatal);
 *  - deleting from the source never deletes locally — `deactivateMissing`
 *    soft-disables (`enabled = false`) so audit/ownership stay intact;
 *  - read-only against the source; `dryRun` never touches the store.
 */

export interface IdentitySyncOptions {
  dryRun?: boolean;
  /** soft-disable local rows whose external id is absent from the snapshot */
  deactivateMissing?: boolean;
}

export interface IdentitySyncCounts {
  created: number;
  updated: number;
  disabled: number;
}

export interface IdentitySyncSummary {
  source: string;
  dryRun: boolean;
  users: IdentitySyncCounts;
  departments: IdentitySyncCounts;
  warnings: string[];
  cursor: string | null;
}

/** external ids that participate in a department parent cycle */
function detectDepartmentCycles(parentOf: Map<string, string | undefined>): Set<string> {
  const cyclic = new Set<string>();
  const state = new Map<string, 1 | 2>();
  for (const start of parentOf.keys()) {
    if (state.has(start)) continue;
    const stack: string[] = [];
    let node: string | undefined = start;
    while (node !== undefined && !state.has(node)) {
      state.set(node, 1);
      stack.push(node);
      node = parentOf.get(node);
    }
    if (node !== undefined && state.get(node) === 1) {
      const from = stack.indexOf(node);
      for (let i = from; i < stack.length; i += 1) cyclic.add(stack[i]!);
    }
    for (const n of stack) state.set(n, 2);
  }
  return cyclic;
}

export async function runIdentitySync(
  source: IdentitySource,
  store: IdentityStore,
  options: IdentitySyncOptions = {},
): Promise<IdentitySyncSummary> {
  const dryRun = options.dryRun === true;
  const deactivate = options.deactivateMissing === true;
  const warnings: string[] = [];

  const previous = await store.getCursor(source.name);
  const pulled = await source.pull(previous ?? undefined);
  const existing = await store.listExternalIds(source.name);
  const existingUsers = new Set(existing.users);
  const existingDepts = new Set(existing.departments);

  const parentOf = new Map<string, string | undefined>();
  for (const d of pulled.departments) parentOf.set(d.externalId, d.parentExternalId);
  const cyclic = detectDepartmentCycles(parentOf);
  for (const id of cyclic) warnings.push(`department "${id}" is part of a parent cycle; its parent link is ignored`);

  const pulledUserIds = new Set(pulled.users.map((u) => u.externalId));
  const pulledDeptIds = new Set(pulled.departments.map((d) => d.externalId));
  const missingUsers = [...existingUsers].filter((id) => !pulledUserIds.has(id));
  const missingDepts = [...existingDepts].filter((id) => !pulledDeptIds.has(id));

  const users: IdentitySyncCounts = {
    created: pulled.users.filter((u) => !existingUsers.has(u.externalId)).length,
    updated: pulled.users.filter((u) => existingUsers.has(u.externalId)).length,
    disabled: deactivate ? missingUsers.length : 0,
  };
  const departments: IdentitySyncCounts = {
    created: pulled.departments.filter((d) => !existingDepts.has(d.externalId)).length,
    updated: pulled.departments.filter((d) => existingDepts.has(d.externalId)).length,
    disabled: deactivate ? missingDepts.length : 0,
  };

  if (!dryRun) {
    // A. upsert departments (no links yet — a child may precede its parent)
    const deptId = new Map<string, string>();
    for (const d of pulled.departments) {
      const { id } = await store.upsertDepartment({
        externalSource: source.name,
        externalId: d.externalId,
        name: d.name ?? null,
        code: d.code ?? null,
        enabled: d.enabled ?? null,
      });
      deptId.set(d.externalId, id);
    }

    const departmentIdFor = async (externalId: string | undefined): Promise<string | null> => {
      if (externalId === undefined) return null;
      const known = deptId.get(externalId);
      if (known !== undefined) return known;
      return (await store.findDepartmentByExternal(source.name, externalId))?.id ?? null;
    };

    // B. upsert users (department link; director resolved in C)
    const userId = new Map<string, string>();
    for (const u of pulled.users) {
      const { id } = await store.upsertUser({
        externalSource: source.name,
        externalId: u.externalId,
        name: u.name ?? null,
        email: u.email ?? null,
        mobile: u.mobile ?? null,
        roles: u.roles ?? [],
        departmentId: await departmentIdFor(u.departmentExternalId),
        directorId: null,
        enabled: u.enabled ?? null,
      });
      userId.set(u.externalId, id);
    }

    // C. user director links (all users now exist)
    for (const u of pulled.users) {
      const directorId =
        u.directorExternalId === undefined
          ? null
          : (userId.get(u.directorExternalId) ?? (await store.findUserByExternal(source.name, u.directorExternalId))?.id ?? null);
      await store.upsertUser({
        externalSource: source.name,
        externalId: u.externalId,
        name: u.name ?? null,
        email: u.email ?? null,
        mobile: u.mobile ?? null,
        roles: u.roles ?? [],
        departmentId: await departmentIdFor(u.departmentExternalId),
        directorId,
        enabled: u.enabled ?? null,
      });
    }

    // D. department parent + manager links
    for (const d of pulled.departments) {
      const parentId = cyclic.has(d.externalId) ? null : await departmentIdFor(d.parentExternalId);
      const managerId =
        d.managerExternalId === undefined
          ? null
          : (userId.get(d.managerExternalId) ?? (await store.findUserByExternal(source.name, d.managerExternalId))?.id ?? null);
      await store.upsertDepartment({
        externalSource: source.name,
        externalId: d.externalId,
        name: d.name ?? null,
        code: d.code ?? null,
        parentId,
        managerId,
        enabled: d.enabled ?? null,
      });
    }

    // E. soft-disable the missing
    if (deactivate) {
      for (const ext of missingUsers) {
        const row = await store.findUserByExternal(source.name, ext);
        if (row !== null) await store.setEnabled('user', row.id, false);
      }
      for (const ext of missingDepts) {
        const row = await store.findDepartmentByExternal(source.name, ext);
        if (row !== null) await store.setEnabled('department', row.id, false);
      }
    }

    if (pulled.cursor !== undefined) await store.setCursor(source.name, pulled.cursor);
  }

  return {
    source: source.name,
    dryRun,
    users,
    departments,
    warnings,
    cursor: pulled.cursor ?? previous ?? null,
  };
}

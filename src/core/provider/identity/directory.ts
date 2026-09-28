import type { IdentitySubject } from './types.js';

/** contract version for `IdentityStore`/`IdentityDirectory` implementers */
export const IDENTITY_STORE_API = 1;

/** a stored user row (contract view; ids are internal uuids) */
export interface IdentityUserRow {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  roles: string[];
  departmentId: string | null;
  directorId: string | null;
  enabled: boolean | null;
}

/** a stored department row (contract view; ids are internal uuids) */
export interface IdentityDepartmentRow {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  parentId: string | null;
  managerId: string | null;
  enabled: boolean | null;
}

/** upsert input for a user (the sync engine fills internal link ids) */
export interface IdentityUserInput {
  externalSource: string;
  externalId: string;
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  roles?: string[];
  departmentId?: string | null;
  directorId?: string | null;
  enabled?: boolean | null;
}

/** upsert input for a department */
export interface IdentityDepartmentInput {
  externalSource: string;
  externalId: string;
  name?: string | null;
  code?: string | null;
  parentId?: string | null;
  managerId?: string | null;
  enabled?: boolean | null;
}

/** greenfield user creation (an engine-owned user with no external source) */
export interface IdentityUserCreate {
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  roles?: string[];
  departmentId?: string | null;
  directorId?: string | null;
  enabled?: boolean | null;
}

/**
 * Replaceable persistence for the local identity directory (default: PG over
 * `weavekit_user`/`weavekit_department`). The engine-only `external_source` +
 * `external_id` pair is the natural key an upsert matches on.
 */
export interface IdentityStore {
  /** look a user up by internal id OR external id (`ref` is matched against both) */
  findUser(ref: string): Promise<IdentityUserRow | null>;
  findUserByExternal(source: string, externalId: string): Promise<IdentityUserRow | null>;
  findDepartmentByExternal(source: string, externalId: string): Promise<IdentityDepartmentRow | null>;
  /** external ids currently stored for a source (used to soft-disable the missing) */
  listExternalIds(source: string): Promise<{ users: string[]; departments: string[] }>;
  upsertUser(input: IdentityUserInput): Promise<{ id: string }>;
  upsertDepartment(input: IdentityDepartmentInput): Promise<{ id: string }>;
  /** create an engine-owned (greenfield) user with no external source */
  createUser(input: IdentityUserCreate): Promise<{ id: string }>;
  /** list local users (admin surface) */
  listUsers(): Promise<IdentityUserRow[]>;
  setEnabled(kind: 'user' | 'department', id: string, enabled: boolean): Promise<void>;
  getCursor(source: string): Promise<string | null>;
  setCursor(source: string, cursor: string): Promise<void>;
}

/** resolve a reference / claims into the internal subject (null = unknown) */
export interface IdentityDirectory {
  resolve(ref: string, claims?: Record<string, unknown>): Promise<IdentitySubject | null>;
}

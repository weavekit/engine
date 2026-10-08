import type { ObjectDefinition } from '../types/index.js';
import { IDENTITY_OBJECT_NAMES } from '../types/values.js';
import { validateObject } from './validate.js';

/**
 * Engine built-in identity objects.
 *
 * These are engine-managed (never declared in a project's `objects/` tree) and
 * live under the reserved `weavekit_` name prefix. They carry the identity used
 * by ownership (`created_by` / `owner_id`) and department-scoped permissions.
 * The `user`/`department` field types target these objects implicitly. Their
 * primary keys are application-generated UUIDs.
 */

/** reserved names of the built-in identity objects */
export const SYSTEM_OBJECT_NAMES = [IDENTITY_OBJECT_NAMES.USER, IDENTITY_OBJECT_NAMES.DEPARTMENT] as const;
export type SystemObjectName = typeof SYSTEM_OBJECT_NAMES[number];

const USER: unknown = {
  name: IDENTITY_OBJECT_NAMES.USER,
  labels: { en: 'User', zh: '用户' },
  // engine-owned table: additive ALTER is allowed (the zero-DDL rule protects
  // only customer tables), so the identity columns below can land on existing DBs
  alter: true,
  constraints: [{ type: 'unique', fields: ['external_source', 'external_id'] }],
  fields: [
    { name: 'id', type: 'uuid', primary: true, required: true },
    { name: 'tenant_id', type: 'string' },
    { name: 'external_source', type: 'string' },
    { name: 'external_id', type: 'string' },
    { name: 'roles', type: 'jsonb' },
    { name: 'name', type: 'string' },
    { name: 'mobile', type: 'string' },
    { name: 'email', type: 'string' },
    { name: 'gender', type: 'string' },
    { name: 'avatar', type: 'string' },
    { name: 'employee_number', type: 'string' },
    { name: 'title', type: 'string' },
    { name: 'position', type: 'string' },
    { name: 'employee_rank', type: 'string' },
    { name: 'entry_date', type: 'date' },
    { name: 'departure_date', type: 'date' },
    { name: 'birthday', type: 'date' },
    { name: 'department_id', type: 'relation', target: IDENTITY_OBJECT_NAMES.DEPARTMENT },
    { name: 'director_id', type: 'relation', target: IDENTITY_OBJECT_NAMES.USER },
    { name: 'enabled', type: 'boolean' },
    { name: 'sort_key', type: 'string' },
    { name: 'description', type: 'text' },
  ],
};

const DEPARTMENT: unknown = {
  name: IDENTITY_OBJECT_NAMES.DEPARTMENT,
  labels: { en: 'Department', zh: '部门' },
  alter: true,
  constraints: [{ type: 'unique', fields: ['external_source', 'external_id'] }],
  fields: [
    { name: 'id', type: 'uuid', primary: true, required: true },
    { name: 'tenant_id', type: 'string' },
    { name: 'external_source', type: 'string' },
    { name: 'external_id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'code', type: 'string' },
    { name: 'parent_id', type: 'relation', target: IDENTITY_OBJECT_NAMES.DEPARTMENT },
    { name: 'manager_id', type: 'relation', target: IDENTITY_OBJECT_NAMES.USER },
    { name: 'enabled', type: 'boolean' },
    { name: 'sort_key', type: 'string' },
    { name: 'description', type: 'text' },
  ],
};

let cache: ObjectDefinition[] | undefined;

/** the validated built-in identity objects (lazily validated, cached) */
export function systemObjects(): ObjectDefinition[] {
  cache ??= [
    validateObject(USER, { allowReservedName: true }),
    validateObject(DEPARTMENT, { allowReservedName: true }),
  ];
  return cache;
}

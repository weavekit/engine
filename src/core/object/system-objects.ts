import type { ObjectDefinition } from '../types/index.js';
import { validateObject } from './validate.js';

/**
 * Engine built-in identity objects.
 *
 * These are engine-managed (never declared in a project's `objects/` tree) and
 * live under the reserved `weavekit_` name prefix. They carry the identity used
 * by ownership (`created_by` / `owner_id`) and, later, department-scoped
 * permissions. Their primary keys are application-generated UUIDs.
 */

/** reserved names of the built-in identity objects */
export const SYSTEM_OBJECT_NAMES = ['weavekit_user', 'weavekit_department'] as const;
export type SystemObjectName = typeof SYSTEM_OBJECT_NAMES[number];

const USER: unknown = {
  name: 'weavekit_user',
  labels: { en: 'User', zh: '用户' },
  fields: [
    { name: 'id', type: 'uuid', primary: true, required: true },
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
    { name: 'department_id', type: 'relation', target: 'weavekit_department' },
    { name: 'manager_id', type: 'relation', target: 'weavekit_user' },
    { name: 'enabled', type: 'boolean' },
    { name: 'sort_key', type: 'string' },
    { name: 'description', type: 'text' },
  ],
};

const DEPARTMENT: unknown = {
  name: 'weavekit_department',
  labels: { en: 'Department', zh: '部门' },
  fields: [
    { name: 'id', type: 'uuid', primary: true, required: true },
    { name: 'name', type: 'string' },
    { name: 'code', type: 'string' },
    { name: 'parent_id', type: 'relation', target: 'weavekit_department' },
    { name: 'manager_id', type: 'relation', target: 'weavekit_user' },
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

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getMeta, setMeta } from '../../core/storage/meta.js';
import type {
  IdentityDepartmentInput,
  IdentityDepartmentRow,
  IdentityStore,
  IdentityUserCreate,
  IdentityUserInput,
  IdentityUserRow,
} from '../../core/provider/identity/index.js';

/**
 * Default `IdentityStore`: PostgreSQL over the engine-owned `weavekit_user` /
 * `weavekit_department` tables. Upserts match on the `(external_source,
 * external_id)` natural key (the composite UNIQUE from B0). Internal ids are
 * application-generated uuids, so the engine id space is independent of any
 * source id space.
 */

interface RawRow {
  id: string;
  external_source: string | null;
  external_id: string | null;
  roles?: unknown;
  department_id?: string | null;
  director_id?: string | null;
  parent_id?: string | null;
  manager_id?: string | null;
  enabled?: boolean | null;
}

function toRoles(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function mapUser(row: RawRow): IdentityUserRow {
  return {
    id: row.id,
    externalSource: row.external_source,
    externalId: row.external_id,
    roles: toRoles(row.roles),
    departmentId: row.department_id ?? null,
    directorId: row.director_id ?? null,
    enabled: row.enabled ?? null,
  };
}

function mapDepartment(row: RawRow): IdentityDepartmentRow {
  return {
    id: row.id,
    externalSource: row.external_source,
    externalId: row.external_id,
    parentId: row.parent_id ?? null,
    managerId: row.manager_id ?? null,
    enabled: row.enabled ?? null,
  };
}

const USER_COLS =
  'id, external_source, external_id, roles, department_id, director_id, enabled';
const DEPT_COLS = 'id, external_source, external_id, parent_id, manager_id, enabled';

export class PgIdentityStore implements IdentityStore {
  constructor(private readonly pool: Pool) {}

  async findUser(ref: string): Promise<IdentityUserRow | null> {
    const res = await this.pool.query(
      `SELECT ${USER_COLS} FROM weavekit_user WHERE id::text = $1 OR external_id = $1 LIMIT 1`,
      [ref],
    );
    const row = res.rows[0] as RawRow | undefined;
    return row === undefined ? null : mapUser(row);
  }

  async findUserByExternal(source: string, externalId: string): Promise<IdentityUserRow | null> {
    const res = await this.pool.query(
      `SELECT ${USER_COLS} FROM weavekit_user WHERE external_source = $1 AND external_id = $2 LIMIT 1`,
      [source, externalId],
    );
    const row = res.rows[0] as RawRow | undefined;
    return row === undefined ? null : mapUser(row);
  }

  async findDepartmentByExternal(source: string, externalId: string): Promise<IdentityDepartmentRow | null> {
    const res = await this.pool.query(
      `SELECT ${DEPT_COLS} FROM weavekit_department WHERE external_source = $1 AND external_id = $2 LIMIT 1`,
      [source, externalId],
    );
    const row = res.rows[0] as RawRow | undefined;
    return row === undefined ? null : mapDepartment(row);
  }

  async listExternalIds(source: string): Promise<{ users: string[]; departments: string[] }> {
    const [users, departments] = await Promise.all([
      this.pool.query(
        `SELECT external_id FROM weavekit_user WHERE external_source = $1 AND external_id IS NOT NULL`,
        [source],
      ),
      this.pool.query(
        `SELECT external_id FROM weavekit_department WHERE external_source = $1 AND external_id IS NOT NULL`,
        [source],
      ),
    ]);
    return {
      users: (users.rows as { external_id: string }[]).map((r) => r.external_id),
      departments: (departments.rows as { external_id: string }[]).map((r) => r.external_id),
    };
  }

  async upsertUser(input: IdentityUserInput): Promise<{ id: string }> {
    const res = await this.pool.query(
      `INSERT INTO weavekit_user
         (id, external_source, external_id, roles, name, email, mobile, department_id, director_id, enabled)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (external_source, external_id) DO UPDATE SET
         roles = EXCLUDED.roles,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         mobile = EXCLUDED.mobile,
         department_id = EXCLUDED.department_id,
         director_id = EXCLUDED.director_id,
         enabled = EXCLUDED.enabled
       RETURNING id`,
      [
        randomUUID(),
        input.externalSource,
        input.externalId,
        JSON.stringify(input.roles ?? []),
        input.name ?? null,
        input.email ?? null,
        input.mobile ?? null,
        input.departmentId ?? null,
        input.directorId ?? null,
        input.enabled ?? null,
      ],
    );
    return { id: (res.rows[0] as { id: string }).id };
  }

  async upsertDepartment(input: IdentityDepartmentInput): Promise<{ id: string }> {
    const res = await this.pool.query(
      `INSERT INTO weavekit_department
         (id, external_source, external_id, name, code, parent_id, manager_id, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (external_source, external_id) DO UPDATE SET
         name = EXCLUDED.name,
         code = EXCLUDED.code,
         parent_id = EXCLUDED.parent_id,
         manager_id = EXCLUDED.manager_id,
         enabled = EXCLUDED.enabled
       RETURNING id`,
      [
        randomUUID(),
        input.externalSource,
        input.externalId,
        input.name ?? null,
        input.code ?? null,
        input.parentId ?? null,
        input.managerId ?? null,
        input.enabled ?? null,
      ],
    );
    return { id: (res.rows[0] as { id: string }).id };
  }

  async setEnabled(kind: 'user' | 'department', id: string, enabled: boolean): Promise<void> {
    const table = kind === 'user' ? 'weavekit_user' : 'weavekit_department';
    await this.pool.query(`UPDATE ${table} SET enabled = $2 WHERE id = $1`, [id, enabled]);
  }

  async createUser(input: IdentityUserCreate): Promise<{ id: string }> {
    const res = await this.pool.query(
      `INSERT INTO weavekit_user (id, name, email, mobile, roles, department_id, director_id, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        randomUUID(),
        input.name ?? null,
        input.email ?? null,
        input.mobile ?? null,
        JSON.stringify(input.roles ?? []),
        input.departmentId ?? null,
        input.directorId ?? null,
        input.enabled ?? null,
      ],
    );
    return { id: (res.rows[0] as { id: string }).id };
  }

  async listUsers(): Promise<IdentityUserRow[]> {
    const res = await this.pool.query(`SELECT ${USER_COLS} FROM weavekit_user ORDER BY name NULLS LAST, id`);
    return (res.rows as RawRow[]).map(mapUser);
  }

  async getCursor(source: string): Promise<string | null> {
    return getMeta(this.pool, `identity.cursor.${source}`);
  }

  async setCursor(source: string, cursor: string): Promise<void> {
    await setMeta(this.pool, `identity.cursor.${source}`, cursor);
  }
}

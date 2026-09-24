import type { Pool } from 'pg';
import {
  AUDIT_ACTOR_TYPES,
  parseSchema,
  type FieldDefinition,
  type Locale,
  type ObjectDefinition,
} from '../../core/index.js';
import { ensureAuditTable, insertAudit } from '../../subsystems/audit/store.js';
import type { SchemaFile } from './loader.js';
import { runGit } from './runner.js';

/**
 * Schema-change diffing shared by the auto-commit message and the queryable
 * `schema.changed` audit trail. The previous state is read from git HEAD (the
 * committed `objects/<name>/schema.json`), the new state from the just-loaded
 * definitions — the same diff feeds both the human-readable commit message and
 * the structured `weavekit_audit` events (one per changed object).
 */

export type SchemaChange =
  | { kind: 'object.added'; object: string; fieldCount: number }
  | { kind: 'object.removed'; object: string }
  | { kind: 'object.updated'; object: string; attr: string; before: unknown; after: unknown }
  | {
      kind: 'field.added';
      object: string;
      field: string;
      type: string;
      default?: unknown;
      required?: boolean;
      options?: string[];
    }
  | { kind: 'field.removed'; object: string; field: string; type: string }
  | { kind: 'field.updated'; object: string; field: string; attr: string; before: unknown; after: unknown }
  | { kind: 'permissions.changed'; object: string; role: string; before: unknown; after: unknown };

const DEFAULT_MESSAGE = 'chore(metadata): sync schema objects';

/** field attributes the audit cares about (what a schema change can affect) */
const FIELD_ATTRS = [
  'type',
  'default',
  'required',
  'unique',
  'options',
  'multiple',
  'target',
  'onDelete',
  'formula',
  'labels',
] as const;

type FieldLike = FieldDefinition & {
  default?: unknown;
  required?: boolean;
  unique?: boolean;
  options?: string[];
  multiple?: boolean;
  target?: string;
  onDelete?: string;
  formula?: string;
};

function normPath(p: string): string {
  return p.split('\\').join('/');
}

/**
 * Repo-relative path of a file (root-relative, `/`-separated, canonical).
 * Uses `git ls-files --full-name` so the path is correct even when the git
 * toplevel and Node disagree on 8.3 short names / separators. Null when the
 * file is untracked (a brand-new object not yet in HEAD).
 */
async function trackedRel(dir: string, absPath: string): Promise<string | null> {
  const res = await runGit(['ls-files', '--full-name', '--', normPath(absPath)], { cwd: dir, allowFailure: true });
  const line = res.stdout.trim();
  return res.code === 0 && line !== '' ? line : null;
}

/** previous committed content of a repo-relative path, or null when not in HEAD */
async function headFile(dir: string, rel: string): Promise<string | null> {
  const res = await runGit(['show', `HEAD:${rel}`], { cwd: dir, allowFailure: true });
  return res.code === 0 ? res.stdout : null;
}

/** object names that have a committed `objects/<name>/schema.json` in HEAD */
async function headSchemaObjects(dir: string): Promise<string[]> {
  const res = await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, allowFailure: true });
  if (res.code !== 0) return [];
  const out: string[] = [];
  for (const line of res.stdout.split('\n')) {
    const m = /^.*objects\/([^/]+)\/schema\.json$/.exec(line.trim());
    if (m !== null) out.push(m[1]!);
  }
  return out;
}

function diffObject(cur: ObjectDefinition, old: ObjectDefinition | undefined): SchemaChange[] {
  const object = cur.name;
  const out: SchemaChange[] = [];
  if (old === undefined) {
    out.push({ kind: 'object.added', object, fieldCount: cur.fields.length });
    return out;
  }

  if (JSON.stringify(cur.labels ?? null) !== JSON.stringify(old.labels ?? null)) {
    out.push({ kind: 'object.updated', object, attr: 'labels', before: old.labels, after: cur.labels });
  }
  if (cur.titleTemplate !== old.titleTemplate) {
    out.push({ kind: 'object.updated', object, attr: 'titleTemplate', before: old.titleTemplate, after: cur.titleTemplate });
  }
  const oldAlter = old.alter === true;
  const curAlter = cur.alter === true;
  if (oldAlter !== curAlter) {
    out.push({ kind: 'object.updated', object, attr: 'alter', before: oldAlter, after: curAlter });
  }

  // permissions: full old/new JSON per role (audit-grade)
  const oldPerms = old.permissions ?? {};
  const curPerms = cur.permissions ?? {};
  const roles = new Set([...Object.keys(oldPerms), ...Object.keys(curPerms)]);
  for (const role of roles) {
    const before = oldPerms[role] ?? null;
    const after = curPerms[role] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ kind: 'permissions.changed', object, role, before, after });
    }
  }

  const oldFields = new Map(old.fields.map((f) => [f.name, f as FieldLike]));
  const curFields = new Map(cur.fields.map((f) => [f.name, f as FieldLike]));
  for (const f of cur.fields) {
    const o = oldFields.get(f.name);
    if (o === undefined) {
      out.push({
        kind: 'field.added',
        object,
        field: f.name,
        type: f.type,
        default: (f as FieldLike).default,
        required: (f as FieldLike).required,
        options: (f as FieldLike).options,
      });
    } else {
      for (const attr of FIELD_ATTRS) {
        const before = o[attr] ?? null;
        const after = (f as FieldLike)[attr] ?? null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          out.push({ kind: 'field.updated', object, field: f.name, attr, before, after });
        }
      }
    }
  }
  for (const f of old.fields) {
    if (!curFields.has(f.name)) {
      out.push({ kind: 'field.removed', object, field: f.name, type: f.type });
    }
  }
  return out;
}

/** compare the loaded schema files against git HEAD and return the change list */
export async function diffMetadata(dir: string, files: SchemaFile[], locale?: Locale): Promise<SchemaChange[]> {
  const inRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, allowFailure: true, locale });
  if (inRepo.stdout.trim() !== 'true') return [];

  const changes: SchemaChange[] = [];
  for (const file of files) {
    const rel = await trackedRel(dir, file.path);
    let old: ObjectDefinition | undefined;
    if (rel !== null) {
      const raw = await headFile(dir, rel);
      if (raw !== null) {
        try {
          old = parseSchema(raw, { locale });
        } catch {
          old = undefined; // unparseable previous state → treat as new
        }
      }
    }
    changes.push(...diffObject(file.object, old));
  }

  const current = new Set(files.map((f) => f.name));
  for (const name of await headSchemaObjects(dir)) {
    if (!current.has(name)) changes.push({ kind: 'object.removed', object: name });
  }
  return changes;
}

function fmt(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '∅';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** human-readable commit message: short subject + per-object field-level body */
export function buildCommitMessage(changes: SchemaChange[]): string {
  if (changes.length === 0) return DEFAULT_MESSAGE;
  const objects = [...new Set(changes.map((c) => c.object))].sort();
  const subject = `chore(metadata): update schema (${objects.length} object${objects.length === 1 ? '' : 's'})`;
  const body: string[] = [];
  const removed: string[] = [];
  for (const object of objects) {
    const objectChanges = changes.filter((c) => c.object === object);
    const objectLines: string[] = [];
    const permLines: string[] = [];
    for (const c of objectChanges) {
      if (c.kind === 'object.added') {
        objectLines.push(`+ ${object} (new object, ${c.fieldCount} fields)`);
      } else if (c.kind === 'object.removed') {
        removed.push(object);
      } else if (c.kind === 'permissions.changed') {
        permLines.push(`    ${c.role}: ${fmt(c.before)} → ${fmt(c.after)}`);
      } else if (c.kind === 'field.added') {
        const extra = `${c.default !== undefined ? `, default ${fmt(c.default)}` : ''}${c.required === true ? ', required' : ''}`;
        objectLines.push(`  + ${c.field} (${c.type}${extra})`);
      } else if (c.kind === 'field.removed') {
        objectLines.push(`  - ${c.field} (${c.type})`);
      } else if (c.kind === 'field.updated') {
        objectLines.push(`  ~ ${c.field} ${c.attr}: ${fmt(c.before)} → ${fmt(c.after)}`);
      } else if (c.kind === 'object.updated') {
        objectLines.push(`  ${c.attr}: ${fmt(c.before)} → ${fmt(c.after)}`);
      }
    }
    if (objectLines.length > 0 || permLines.length > 0) {
      body.push(`${object}:`);
      body.push(...objectLines);
      if (permLines.length > 0) {
        body.push('  permissions:');
        body.push(...permLines);
      }
    }
  }
  if (removed.length > 0) {
    body.push('removed:');
    for (const r of removed) body.push(`  - ${r}`);
  }
  return `${subject}\n\n${body.join('\n')}`;
}

/** git author of the last commit (used as the audit actor); 'system' when unavailable */
export async function gitCommitAuthor(dir: string): Promise<string> {
  const res = await runGit(['log', '-1', '--format=%an <%ae>'], { cwd: dir, allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : 'system';
}

export interface SchemaAuditCommit {
  sha?: string;
  author?: string;
  /** objects whose DDL was applied by this sync */
  applied?: string[];
}

/**
 * Record schema changes as `schema.changed` audit events in `weavekit_audit`
 * (one per changed object). Written directly (not through the audit subsystem)
 * so schema history is kept regardless of the runtime-audit toggle; the full
 * before/after stays authoritative in git, this is the queryable summary.
 */
export async function recordSchemaChanges(
  pool: Pool,
  changes: SchemaChange[],
  files: SchemaFile[],
  commit: SchemaAuditCommit,
): Promise<void> {
  if (changes.length === 0) return;
  await ensureAuditTable(pool);

  const byObject = new Map<string, SchemaChange[]>();
  for (const c of changes) {
    const list = byObject.get(c.object) ?? [];
    list.push(c);
    byObject.set(c.object, list);
  }
  const defs = new Map(files.map((f) => [f.name, f.object]));
  const actorId = commit.author ?? 'system';
  const actorType = actorId === 'system' ? AUDIT_ACTOR_TYPES.SYSTEM : AUDIT_ACTOR_TYPES.USER;

  for (const [object, objectChanges] of byObject) {
    const def = defs.get(object);
    await insertAudit(pool, {
      actorType,
      actorId,
      action: 'schema.changed',
      objectName: object,
      changes: objectChanges,
      meta: {
        commitSha: commit.sha ?? null,
        alter: def?.alter === true,
        ddlApplied: commit.applied?.includes(object) === true,
      },
      timestamp: new Date(),
    });
  }
}

/** one object's applied workflow state remaps (from `weave workflow:migrate`) */
export interface WorkflowMigrationAuditEntry {
  object: string;
  stateField: string;
  /** definition revision that declared the remaps */
  version?: number;
  /** semantic hash of the definition that declared the remaps */
  hash?: string;
  moved: Array<{ from: string; to: string; rows: number }>;
}

/**
 * Record applied workflow state remaps as `workflow.migrated` audit events
 * (system actor). Kept out of the runtime audit toggle, like `schema.changed`,
 * so a data migration is always traceable. No event is written when nothing moved.
 */
export async function recordWorkflowMigration(
  pool: Pool,
  entries: WorkflowMigrationAuditEntry[],
  commit: { author?: string } = {},
): Promise<void> {
  const applied = entries.filter((entry) => entry.moved.length > 0);
  if (applied.length === 0) return;
  await ensureAuditTable(pool);
  const actorId = commit.author ?? 'system';
  const actorType = actorId === 'system' ? AUDIT_ACTOR_TYPES.SYSTEM : AUDIT_ACTOR_TYPES.USER;
  for (const entry of applied) {
    await insertAudit(pool, {
      actorType,
      actorId,
      action: 'workflow.migrated',
      objectName: entry.object,
      changes: { stateField: entry.stateField, moved: entry.moved },
      meta: {
        workflowVersion: entry.version ?? null,
        workflowHash: entry.hash ?? null,
      },
      timestamp: new Date(),
    });
  }
}

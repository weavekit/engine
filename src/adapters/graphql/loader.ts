import {
  DETAILS_COLUMNS,
  decodeRecordKey,
  FIELD_TYPES,
  primaryFieldsOf,
  RECORD_META_ID_FIELD,
  type IdentitySubject,
  type ObjectDefinition,
} from '../../core/index.js';
import type { DataAccessContext } from '../../runtime/data-access/index.js';
import type { GraphQLEngine, RecordLoader } from './types.js';

/**
 * Same-tick batching loader (a tiny DataLoader) used by nested relation
 * resolvers. GraphQL resolves a layer's sibling fields in one synchronous pass,
 * so every `load`/`loadChildren` issued before the queued microtask runs is
 * merged into a single data-access query:
 *
 * - records: one `find` with `pk IN (…)` (single-column keys) — composite-key
 *   targets fall back to per-key `findOne`;
 * - children: one `find` with `parent_id IN (…)`, grouped + ordered by
 *   `parent_idx`.
 *
 * A loader is created **per request** and closes over the subject, so batches
 * never mix identities (no cross-identity cache leak).
 */

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function createRecordLoader(engine: GraphQLEngine, subject: IdentitySubject): RecordLoader {
  const recordPending = new Map<string, Map<string, Pending<Record<string, unknown> | null>[]>>();
  const childPending = new Map<string, Map<string, Pending<Record<string, unknown>[]>[]>>();
  let scheduled = false;

  const context = (): DataAccessContext => ({
    pool: engine.pool,
    registry: engine.registry,
    subject,
    locale: engine.locale,
  });

  const projection = (def: ObjectDefinition, extra: readonly string[] = []): string[] => [
    ...def.fields.filter((f) => f.type !== FIELD_TYPES.DETAILS).map((f) => f.name),
    ...extra,
    RECORD_META_ID_FIELD,
  ];

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      void flush();
    });
  };

  async function flush(): Promise<void> {
    scheduled = false;
    const records = new Map(recordPending);
    const children = new Map(childPending);
    recordPending.clear();
    childPending.clear();
    await Promise.all([
      ...[...records].map(([object, byKey]) => flushRecords(object, byKey)),
      ...[...children].map(([object, byKey]) => flushChildren(object, byKey)),
    ]);
  }

  async function flushRecords(
    objectName: string,
    byKey: Map<string, Pending<Record<string, unknown> | null>[]>,
  ): Promise<void> {
    try {
      const rows = await loadRecords(objectName, [...byKey.keys()]);
      const byId = new Map(rows.map((row) => [String(row[RECORD_META_ID_FIELD]), row]));
      for (const [key, entries] of byKey) {
        const value = byId.get(key) ?? null;
        for (const entry of entries) entry.resolve(value);
      }
    } catch (error) {
      for (const entries of byKey.values()) for (const entry of entries) entry.reject(error);
    }
  }

  async function loadRecords(objectName: string, keys: string[]): Promise<Record<string, unknown>[]> {
    const def = engine.registry.get(objectName);
    if (def === undefined) return [];
    const pks = primaryFieldsOf(def);
    if (pks.length === 1) {
      const values = keys.map((key) => {
        try {
          return decodeRecordKey(key)[0]!;
        } catch {
          return key;
        }
      });
      const result = await engine.dataAccess.find(
        objectName,
        { filter: { [pks[0]!.name]: { in: values } }, fields: projection(def) },
        context(),
      );
      return result.rows;
    }
    const rows: Record<string, unknown>[] = [];
    for (const key of keys) {
      const row = await engine.dataAccess.findOne(objectName, key, context());
      if (row !== null) rows.push(row);
    }
    return rows;
  }

  async function flushChildren(
    childObject: string,
    byKey: Map<string, Pending<Record<string, unknown>[]>[]>,
  ): Promise<void> {
    try {
      const rows = await loadChildrenRows(childObject, [...byKey.keys()]);
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        const parentId = String(row[DETAILS_COLUMNS.PARENT_ID] ?? '');
        const list = grouped.get(parentId);
        if (list === undefined) grouped.set(parentId, [row]);
        else list.push(row);
      }
      for (const list of grouped.values()) {
        list.sort(
          (a, b) =>
            Number(a[DETAILS_COLUMNS.PARENT_IDX] ?? 0) - Number(b[DETAILS_COLUMNS.PARENT_IDX] ?? 0),
        );
      }
      for (const [key, entries] of byKey) {
        const list = grouped.get(key) ?? [];
        for (const entry of entries) entry.resolve(list);
      }
    } catch (error) {
      for (const entries of byKey.values()) for (const entry of entries) entry.reject(error);
    }
  }

  async function loadChildrenRows(childObject: string, parentKeys: string[]): Promise<Record<string, unknown>[]> {
    const def = engine.registry.get(childObject);
    if (def === undefined) return [];
    const result = await engine.dataAccess.find(
      childObject,
      {
        filter: { [DETAILS_COLUMNS.PARENT_ID]: { in: parentKeys } },
        fields: projection(def, [DETAILS_COLUMNS.PARENT_ID, DETAILS_COLUMNS.PARENT_IDX]),
      },
      context(),
    );
    return result.rows;
  }

  function enqueue<T>(
    store: Map<string, Map<string, Pending<T>[]>>,
    objectName: string,
    key: string,
    entry: Pending<T>,
  ): void {
    const byKey = store.get(objectName) ?? new Map();
    store.set(objectName, byKey);
    const list = byKey.get(key) ?? [];
    list.push(entry);
    byKey.set(key, list);
    schedule();
  }

  return {
    load(objectName, recordKey) {
      return new Promise((resolve, reject) => {
        enqueue(recordPending, objectName, recordKey, { resolve, reject });
      });
    },
    loadChildren(childObject, parentKey) {
      return new Promise((resolve, reject) => {
        enqueue(childPending, childObject, parentKey, { resolve, reject });
      });
    },
  };
}

import type { ObjectDefinition } from '../../types/index.js';
import { fail, isRecord, INDEX_TYPE_VALUES, type Vc } from './primitives.js';

/** validate the optional indexes array (btree/gin/gist + non-empty string fields) */
export function validateIndexes(raw: unknown, vc: Vc): ObjectDefinition['indexes'] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(vc, 'index.notArray');
  return raw.map((entry, i) => {
    if (!isRecord(entry)) fail(vc, 'index.notObject', { i });
    const type = entry.type;
    if (typeof type !== 'string' || !INDEX_TYPE_VALUES.includes(type)) {
      fail(vc, 'index.type.invalid', { i, types: INDEX_TYPE_VALUES.join('/') });
    }
    if (!Array.isArray(entry.fields) || entry.fields.length === 0 || !entry.fields.every((f) => typeof f === 'string')) {
      fail(vc, 'index.fields.invalid', { i });
    }
    return { type: type as 'btree' | 'gin' | 'gist', fields: entry.fields as string[] };
  });
}

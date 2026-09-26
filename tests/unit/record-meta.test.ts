import { describe, it, expect } from '../helpers/test.js';
import {
  buildRecordMetaTable,
  isRecordMetaTable,
  recordMetaTableName,
  RECORD_META_COLUMNS,
  RECORD_META_DEFAULT_STATUS,
  RECORD_META_TABLE_PREFIX,
} from '../../src/core/storage/record-meta.js';

describe('record metadata side table', () => {
  it('names tables with the reserved prefix', () => {
    expect(recordMetaTableName('orders')).toBe(`${RECORD_META_TABLE_PREFIX}orders`);
    expect(isRecordMetaTable('weavekit_record__orders')).toBe(true);
    expect(isRecordMetaTable('orders')).toBe(false);
  });

  it('builds the expected side-table shape', () => {
    const t = buildRecordMetaTable('orders');
    expect(t.name).toBe('weavekit_record__orders');

    const byName = new Map(t.columns.map((c) => [c.name, c]));
    expect([...byName.keys()]).toEqual([
      'record_key',
      'status',
      'owner_id',
      'created_by',
      'modified_by',
      'created_time',
      'modified_time',
      'workflow_id',
    ]);

    const pk = byName.get(RECORD_META_COLUMNS.RECORD_KEY);
    expect(pk?.primary).toBe(true);
    expect(pk?.type).toBe('TEXT');

    const status = byName.get(RECORD_META_COLUMNS.STATUS);
    expect(status?.notNull).toBe(true);
    expect(status?.default).toBe(`'${RECORD_META_DEFAULT_STATUS}'`);

    expect(byName.get(RECORD_META_COLUMNS.CREATED_TIME)?.type).toBe('TIMESTAMPTZ');
    expect(byName.get(RECORD_META_COLUMNS.OWNER_ID)?.type).toBe('UUID');

    // owner/status indexes for the RBAC + workflow filters
    expect(t.indexes.map((i) => i.name)).toEqual([
      'weavekit_record__orders_status_idx',
      'weavekit_record__orders_owner_idx',
    ]);
    expect(t.fks).toEqual([]);
  });

  it('creates a distinct table per object', () => {
    expect(buildRecordMetaTable('a').name).not.toBe(buildRecordMetaTable('b').name);
  });
});

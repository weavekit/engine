import type { SeqNoField } from '../../core/index.js';
import type { Queryable } from './types.js';

const SEQ_TABLE = 'weavekit_seq';

/** create the seq counter table if it does not exist (once per write transaction) */
export async function ensureSeqTable(db: Queryable): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${SEQ_TABLE} (
       object_name text NOT NULL,
       bucket text NOT NULL,
       last_value bigint NOT NULL,
       PRIMARY KEY (object_name, bucket)
     )`,
  );
}

/** counter bucket: format literal prefix; for cycle=year the year is baked in */
export function seqBucket(field: SeqNoField, format: string, now: Date): string {
  const idx = format.indexOf('{seq');
  const prefix = idx === -1 ? format : format.slice(0, idx);
  return field.cycle === 'year' ? prefix.replace(/\{year\}/g, String(now.getFullYear())) : prefix;
}

/** render a sequence value through the format template ({seq}, {seq:N}, {year}/{month}/{day}) */
export function renderSeq(format: string, lastValue: number, now: Date): string {
  return format
    .replace(/\{seq(?::(\d+))?\}/g, (_m, pad: string | undefined) => {
      const s = String(lastValue);
      return pad !== undefined && s.length < Number(pad) ? s.padStart(Number(pad), '0') : s;
    })
    .replace(/\{year\}/g, String(now.getFullYear()))
    .replace(/\{month\}/g, String(now.getMonth() + 1))
    .replace(/\{day\}/g, String(now.getDate()));
}

/** atomically allocate the next sequence value for (object, field) and render it */
export async function generateSeqNo(
  db: Queryable,
  object: string,
  field: SeqNoField,
  now: Date,
): Promise<string> {
  const format = field.format ?? '{seq}';
  const bucket = seqBucket(field, format, now);
  const res = await db.query<{ last_value: number }>(
    `INSERT INTO ${SEQ_TABLE} (object_name, bucket, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (object_name, bucket) DO UPDATE SET last_value = ${SEQ_TABLE}.last_value + 1
     RETURNING last_value`,
    [object, bucket],
  );
  return renderSeq(format, res.rows[0]!.last_value, now);
}

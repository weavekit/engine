import { describe, it, expect } from '../helpers/test.js';
import { EVENT_TYPES } from '../../src/core/provider/event/index.js';
import { createEventBus, publisherOf } from '../../src/infrastructure/event/index.js';

const collect = () => {
  const events: { type: string; payload: unknown }[] = [];
  return { events, push: (e: { type: string; payload: unknown }) => events.push(e) };
};

describe('createEventBus — seq/subscription/replay (M12a)', () => {
  it('publish assigns monotonic seq + ts, delivers to subscribers', () => {
    const bus = createEventBus();
    const got = collect();
    const off = bus.subscribe((e) => got.push({ type: e.type, payload: e.payload }));
    bus.publish({ type: EVENT_TYPES.SCHEMA_CHANGED, payload: { kind: 'schema' } });
    bus.publish({ type: EVENT_TYPES.RECORD_CREATED, payload: { object: 'lead', id: 'L1' } });
    expect(got.events).toHaveLength(2);
    expect(got.events[0]!.type).toBe(EVENT_TYPES.SCHEMA_CHANGED);
    expect(got.events[1]!.payload).toEqual({ object: 'lead', id: 'L1' });
    expect(bus.lastSeq()).toBe(2);
    off();
  });

  it('no delivery after unsubscribe; listener throw does not break the bus', () => {
    const bus = createEventBus();
    const got = collect();
    const boom = () => {
      throw new Error('boom');
    };
    bus.subscribe(boom);
    const off = bus.subscribe((e) => got.push({ type: e.type, payload: e.payload }));
    bus.publish({ type: EVENT_TYPES.SCHEMA_CHANGED, payload: { kind: 'schema' } }); // boom swallowed
    off();
    bus.publish({ type: EVENT_TYPES.SCHEMA_CHANGED, payload: { kind: 'schema' } });
    expect(got.events).toHaveLength(1);
  });

  it('replay: afterSeq exact backfill / empty-buffer restart gap / ring-overflow gap', () => {
    const bus = createEventBus({ maxEvents: 2 });
    for (let i = 0; i < 4; i += 1) bus.publish({ type: EVENT_TYPES.RECORD_CREATED, payload: { object: 'lead', id: `L${i}` } });
    // ring buffer keeps only seq 3,4
    expect(bus.lastSeq()).toBe(4);

    const replayed = collect();
    // afterSeq=1 is two events before buffer head seq3 → gap
    const gap = bus.replay(1, (e) => replayed.push({ type: e.type, payload: e.payload }));
    expect(gap).toBe('gap');

    const ok2 = bus.replay(2, (e) => replayed.push({ type: e.type, payload: e.payload }));
    expect(ok2).toBe('ok');
    expect(replayed.events).toEqual([
      { type: EVENT_TYPES.RECORD_CREATED, payload: { object: 'lead', id: 'L2' } },
      { type: EVENT_TYPES.RECORD_CREATED, payload: { object: 'lead', id: 'L3' } },
    ]);

    // empty buffer (restart): afterSeq>0 → gap; afterSeq=0 → ok
    const bus2 = createEventBus();
    expect(bus2.replay(5, () => {})).toBe('gap');
    expect(bus2.replay(0, () => {})).toBe('ok');
  });

  it('publisherOf mapping: record actions → event types; audit/schema published directly', () => {
    const bus = createEventBus();
    const got = collect();
    bus.subscribe((e) => got.push({ type: e.type, payload: e.payload }));
    const p = publisherOf(bus);
    p.publishRecordChange('created', 'lead', 'L1');
    p.publishRecordChange('updated', 'lead', 'L1');
    p.publishRecordChange('deleted', 'lead', 'L1');
    p.publishSchemaChanged();
    p.publishAudit({ actorType: 'user', actorId: 'u1', action: 'create', timestamp: new Date() });
    expect(got.events.map((e) => e.type)).toEqual([
      EVENT_TYPES.RECORD_CREATED,
      EVENT_TYPES.RECORD_UPDATED,
      EVENT_TYPES.RECORD_DELETED,
      EVENT_TYPES.SCHEMA_CHANGED,
      EVENT_TYPES.AUDIT_EVENT,
    ]);
    expect(got.events[4]!.payload).toMatchObject({ event: { actorId: 'u1' } });
  });

  it('publisherOf lifecycle: publishLifecycle broadcasts lifecycle.shutdown (single source)', () => {
    const bus = createEventBus();
    const got = collect();
    bus.subscribe((e) => got.push({ type: e.type, payload: e.payload }));
    publisherOf(bus).publishLifecycle('shutdown');
    expect(EVENT_TYPES.LIFECYCLE_SHUTDOWN).toBe('lifecycle.shutdown');
    expect(got.events).toEqual([{ type: EVENT_TYPES.LIFECYCLE_SHUTDOWN, payload: { kind: 'shutdown' } }]);
  });
});

import {
  EVENT_TYPES,
  type EngineEvent,
  type EventBus,
  type EventPublisher,
  type PublishInput,
  type RecordAction,
  type ReplayResult,
} from '../../core/provider/event/index.js';

/** event bus options */
export interface EventBusOptions {
  /** retained events for Last-Event-ID replay; defaults to 1000 */
  maxEvents?: number;
}

const RECORD_EVENT_TYPES: Record<RecordAction, (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]> = {
  created: EVENT_TYPES.RECORD_CREATED,
  updated: EVENT_TYPES.RECORD_UPDATED,
  deleted: EVENT_TYPES.RECORD_DELETED,
};

/**
 * In-process event bus with a bounded replay ring buffer. `publish` assigns a
 * monotonically increasing `seq` (the SSE replay anchor) and delivers to all
 * current listeners synchronously. The ring buffer is in-memory only: after a
 * process restart `replay` reports `gap` for any non-empty `afterSeq`, which
 * the SSE adapter turns into a `schema.changed` nudge (client refetches via
 * REST). A listener throwing never breaks the bus.
 */
export function createEventBus(options: EventBusOptions = {}): EventBus {
  const maxEvents = options.maxEvents ?? 1000;
  let seq = 0;
  const listeners = new Set<(event: EngineEvent) => void>();
  const buffer: EngineEvent[] = [];

  const bus: EventBus = {
    publish(input: PublishInput): void {
      seq += 1;
      const event: EngineEvent = { seq, ts: new Date(), type: input.type, payload: input.payload };
      buffer.push(event);
      if (buffer.length > maxEvents) buffer.shift();
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // listener errors never break the bus (best-effort delivery)
        }
      }
    },

    subscribe(listener: (event: EngineEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    replay(afterSeq: number, listener: (event: EngineEvent) => void): ReplayResult {
      if (afterSeq < 0) return 'ok'; // no replay requested
      if (buffer.length === 0) return afterSeq === 0 ? 'ok' : 'gap'; // restart: nothing retained
      if (afterSeq < buffer[0]!.seq - 1) return 'gap'; // ring overflowed the requested window
      for (const event of buffer) {
        if (event.seq > afterSeq) listener(event);
      }
      return 'ok';
    },

    lastSeq(): number {
      return seq;
    },

    close(): void {
      listeners.clear();
      buffer.length = 0;
      seq = 0;
    },
  };
  return bus;
}

/** narrow publisher facade injected into data-access / audit / assembly */
export function publisherOf(bus: EventBus): EventPublisher {
  return {
    publishRecordChange(action: RecordAction, object: string, id: string): void {
      bus.publish({ type: RECORD_EVENT_TYPES[action], payload: { object, id } });
    },
    publishRecordTransitioned(
      object: string,
      id: string,
      from: string,
      to: string,
      action: string,
      workflowVersion?: number,
      workflowHash?: string,
    ): void {
      bus.publish({
        type: EVENT_TYPES.RECORD_TRANSITIONED,
        payload: {
          object,
          id,
          from,
          to,
          action,
          ...(workflowVersion === undefined ? {} : { workflowVersion }),
          ...(workflowHash === undefined ? {} : { workflowHash }),
        },
      });
    },
    publishAudit(event): void {
      bus.publish({ type: EVENT_TYPES.AUDIT_EVENT, payload: { event } });
    },
    publishSchemaChanged(): void {
      bus.publish({ type: EVENT_TYPES.SCHEMA_CHANGED, payload: { kind: 'schema' } });
    },
    publishSchemaDrift(payload): void {
      bus.publish({ type: EVENT_TYPES.SCHEMA_DRIFT, payload });
    },
    publishLifecycle(kind): void {
      bus.publish({ type: EVENT_TYPES.LIFECYCLE_SHUTDOWN, payload: { kind } });
    },
  };
}

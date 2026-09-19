import type { FastifyInstance } from 'fastify';
import { EVENT_TYPES, listObjectDescriptors } from '../../core/index.js';
import type { Locale, ObjectRegistry, RbacSubject } from '../../core/index.js';
import type {
  AuditEventPayload,
  EngineEvent,
  EventBus,
  RecordChangePayload,
} from '../../core/provider/event/index.js';
import type { SlidingWindow } from '../../core/limiter/index.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit } from '../rest/common.js';
import { createSseStream, type SseStream } from './stream.js';

/**
 * Live event endpoint (M12, framework-agnostic push channel):
 *   GET {prefix}/events  (SSE over `Authorization: Bearer`)
 *
 * Every connection is bound to the authenticated subject and filtered before
 * delivery (a push must never leak a record the identity cannot read, nor an
 * audit event it may not see):
 *   - record.* events   → object must be readable (mirrors MCP list_objects)
 *   - audit.event       → own actorId only, unless the subject holds an admin role
 *   - schema.changed    → broadcast (cache-invalidation nudge, no payload)
 *
 * Reconnect: the client sends `Last-Event-ID: <seq>`; buffered events are
 * replayed from the ring buffer. When the requested window is unrecoverable
 * (process restart / overflow) a `schema.changed` nudge is sent instead, so the
 * client refetches metadata/permissions via REST.
 */

export interface EventsDeps {
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
  bus: EventBus;
  /** roles allowed to see every actor's audit events (mirrors adapters.rest.adminRoles) */
  adminRoles?: string[];
}

export interface EventsOptions {
  /** URL prefix; defaults to `/api` */
  prefix?: string;
  /** keep-alive ping interval in ms; defaults to 30s */
  heartbeatMs?: number;
  /** per-agent-key sliding-window limiter; disabled when absent */
  rateLimiter?: SlidingWindow;
  /** CORS origin allowed on the SSE response (mirrors adapters.rest.cors.origin) */
  corsOrigin?: string | string[] | boolean;
}

function passesFilter(event: EngineEvent, subject: RbacSubject, readable: Set<string>, isAdmin: boolean): boolean {
  switch (event.type) {
    case EVENT_TYPES.RECORD_CREATED:
    case EVENT_TYPES.RECORD_UPDATED:
    case EVENT_TYPES.RECORD_DELETED: {
      const payload = event.payload as RecordChangePayload;
      return readable.has(payload.object);
    }
    case EVENT_TYPES.AUDIT_EVENT: {
      const payload = event.payload as AuditEventPayload;
      return isAdmin || payload.event.actorId === subject.id;
    }
    default:
      return true; // schema.changed — broadcast
  }
}

export function registerEventsRoutes(app: FastifyInstance, deps: EventsDeps, options: EventsOptions = {}): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale, bus } = deps;
  const adminRoles = new Set(deps.adminRoles ?? []);

  // Active SSE streams. On app close they are ended so `server.close()` (inside
  // Fastify `app.close()`) is not left waiting on the long-lived connections —
  // otherwise hot reload (`weave dev`) hangs while a frontend keeps `/api/events`
  // open. Clients reconnect with `Last-Event-ID` to replay the gap.
  const streams = new Set<SseStream>();

  app.addHook('onClose', async () => {
    for (const stream of streams) stream.close();
    streams.clear();
  });

  app.get(`${prefix}/events`, async (request, reply) => {
    checkRateLimit(options.rateLimiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const readable = new Set(listObjectDescriptors(registry, subject.roles).map((o) => o.name));
    const isAdmin = subject.roles.some((r) => adminRoles.has(r));

    reply.hijack();

    let unsubscribe = (): void => {};
    const stream = createSseStream(reply, {
      heartbeatMs: options.heartbeatMs,
      onClose: () => {
        unsubscribe();
        streams.delete(stream);
      },
      corsOrigin: options.corsOrigin,
    });
    streams.add(stream);

    const deliver = (event: EngineEvent): void => {
      if (passesFilter(event, subject, readable, isAdmin)) stream.write(event);
    };

    const rawLast = request.headers['last-event-id'];
    const afterSeq = rawLast === undefined ? -1 : Number.parseInt(String(Array.isArray(rawLast) ? rawLast[0] : rawLast), 10);
    const replayAfter = Number.isNaN(afterSeq) ? -1 : afterSeq;
    if (replayAfter >= 0) {
      const result = bus.replay(replayAfter, deliver);
      if (result === 'gap') {
        // restart / ring overflow: continuity lost — tell the client to refetch
        stream.writeRaw(EVENT_TYPES.SCHEMA_CHANGED, {
          type: EVENT_TYPES.SCHEMA_CHANGED,
          payload: { kind: 'schema', replayGap: true },
        });
      }
    }

    unsubscribe = bus.subscribe(deliver);
  });
}

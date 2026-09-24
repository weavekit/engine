# Live events (SSE)

The engine pushes a live event stream so a frontend can react to data and metadata changes without
polling. It is a Server-Sent Events endpoint over the same Bearer auth as the REST API:

```
GET {prefix}/events
Accept: text/event-stream
Authorization: Bearer <key>
```

Each connection is bound to the authenticated subject and **filtered before delivery** — a push must
never leak a record the identity cannot read, nor an audit event it may not see.

## Event types

| `type` | Payload | Delivered to |
| --- | --- | --- |
| `record.created` / `record.updated` / `record.deleted` | `{ object, id }` | identities that can read `object` |
| `record.transitioned` | `{ object, id, from, to, action }` | identities that can read `object` |
| `audit.event` | `{ event }` (the full audit event) | the event's own `actorId`, or any `adminRoles` holder |
| `schema.changed` | `{ kind: 'schema' }` | everyone (cache-invalidation nudge, no payload) |
| `schema.drift` | `{ object, field?, message }` | everyone (a `weave dev` reload was rejected) |
| `lifecycle.shutdown` | `{ kind: 'shutdown' }` | everyone (instance exiting) |

Record payloads carry only the object name and id — never column values. Subscribers refetch the row
through the REST API (with their own RBAC) if they need the data. A workflow transition emits
`record.transitioned` (with `from`/`to`/`action`) **in addition to** `record.updated`, so generic
cache-invalidation listeners keep working while workflow-aware ones can react to the state change.

## Wire format

Each event is one SSE block; the sequence number is the event id:

```
id: 42
event: record.updated
data: {"seq":42,"ts":"2026-09-22T10:00:00.000Z","type":"record.updated","payload":{"object":"lead","id":"e1"}}
```

A `: ping` comment is sent every 30s as a keep-alive (`events.heartbeatMs` to change it).

## Reconnect and replay

On reconnect, send the last id you saw and the engine replays the gap from its bounded ring buffer:

```js
const source = new EventSource(url); // browser sets Last-Event-ID automatically
```

`GET {prefix}/events` reads the `Last-Event-ID` header (or you set it on reconnect). If the requested
window is unrecoverable (process restart or buffer overflow) the engine sends a `schema.changed` event
with `payload.replayGap: true` instead — the client should then refetch metadata and permissions over
REST and treat its cached view as stale.

## Enable

The events adapter is on by default; disable or re-prefix it in `weavekit.config.ts`:

```ts
export default {
  adapters: {
    events: { enabled: true, prefix: '/api' },
    rest: { adminRoles: ['admin'] }, // reused for audit-event visibility
  },
};
```

- `adapters.events.enabled: false` removes the route (no import, no overhead).
- `adminRoles` mirrors `adapters.rest.adminRoles` — it decides who sees **every** actor's audit events.
- `corsOrigin` mirrors `adapters.rest.cors.origin`; the SSE response is hijacked, so the
  `Access-Control-Allow-Origin` header is written on it directly.

## Consume from the client SDK

`@weave-kit/client` wraps the stream (fetch-based, so the key travels in the Bearer header;
auto-reconnects with backoff and sends `Last-Event-ID`):

```ts
const client = createClient({ baseUrl, apiKey });
const subscription = client.subscribe({
  onEvent(event) {
    if (event.type === 'schema.changed') void client.metadata.list();
  },
});
// later
subscription.close();
```

## Next

- [Audit](audit.md) — the durable, queryable event log (SSE is the live tail)
- [Git-versioned metadata](git-versioned-metadata.md) — what triggers `schema.changed`

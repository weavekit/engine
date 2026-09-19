# Audit

The audit subsystem records immutable events for every data mutation (and read denials) on a single, uniform boundary — the data-access layer. REST, MCP, and any future interface inherit it automatically with zero per-interface code.

Audit is an **optional subsystem**: disabled by default, and when disabled it is not loaded at all (no import, no table, no queries).

## Enable

```ts
// weavekit.config.ts
export default {
  // ...
  subsystems: {
    audit: {
      enabled: true,
      retention: '90d',                          // placeholder (auto-cleanup later)
      batch: { batchSize: 50, flushMs: 100 },    // optional; defaults shown
    },
  },
};
```

## What gets audited automatically

The engine records events at the **data-access boundary** — so every `create` / `update` / `delete` via REST, MCP tools, or future GraphQL produces an event, **including failures**:

| Event | When |
| --- | --- |
| `create` | record created (success) |
| `create` (isError) | validation failed, e.g. `data.field.required` |
| `update` | record updated (success) |
| `update` (isError) | RBAC denial (`rbac.denied.update` / `rbac.denied.field`) or record not found |
| `delete` | record deleted (success) |
| `delete` (isError) | RBAC denial or record not found |
| `read` (isError) | read denied (`rbac.denied.read`) |

Failed and denied operations are audit highlights — they are exactly the attempts you want to review.

## Event model

```ts
interface AuditEvent {
  actorType: 'user' | 'system' | 'agent' | 'anonymous';  // AUDIT_ACTOR_TYPES
  actorId: string;          // subject.id, or 'system', or agent key
  action: string;           // DATA_ACTIONS (create/update/delete/read) or '<prefix>.<detail>'
  objectName?: string;      // object name
  objectId?: string;        // record id
  changes?: unknown;        // write payload / change summary
  isError?: boolean;
  errorCode?: string;       // engine SchemaError code, e.g. 'rbac.denied.field'
  meta?: Record<string, unknown>;  // e.g. agent on-behalf-of
  timestamp: Date;          // the business moment, not the flush time
}
```

The enum-like fields are backed by `as const` constants exported from the engine:

- `AUDIT_ACTOR_TYPES` — `AGENT / USER / SYSTEM / ANONYMOUS`
- `DATA_ACTIONS` — `CREATE / UPDATE / DELETE / READ`
- `ACTION_PREFIXES` — `MCP_TOOL ('mcp.tool')`, `REST ('rest')` — interface-layer actions compose as `<prefix>.<detail>`

## Querying

`engine.audit` is exposed when the subsystem is enabled:

```ts
const engine = await createEngine({ /* ... */, subsystems: { audit: { enabled: true } } });

const { rows, total } = await engine.audit.query({
  actorId: 'u100',
  action: DATA_ACTIONS.UPDATE,
  objectName: 'lead',
  from: new Date('2026-08-01'),
  to: new Date(),
  limit: 50,
  offset: 0,
});
// rows are AuditEvent[], ordered ts DESC
```

## Buffering semantics (fire-and-forget)

`record()` queues the event in memory and returns immediately — **audit never blocks the business critical path**, which matters under concurrent multi-user load. Events are flushed as a single multi-row `INSERT` when the batch fills (`batchSize`) or the flush window elapses (`flushMs`).

- `engine.close()` flushes the remaining buffer before the pool shuts down.
- A process crash loses only the most recent, not-yet-flushed events (audit is best-effort).
- Batch-write failures call `onError` (default `console.error`) and never throw into the caller.
- The stored `timestamp` is the business moment, so delayed flushing does not distort the audit trail.

## Table

```
weavekit_audit (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL,       -- event timestamp (business moment)
  actor_type  text NOT NULL,
  actor_id    text NOT NULL,
  action      text NOT NULL,
  object      text,
  object_id   text,
  changes     jsonb,
  is_error    boolean NOT NULL DEFAULT false,
  error_code  text,
  meta        jsonb
);
-- indexes: (ts DESC), (actor_id), (object, object_id)
```

Append-only by contract: the engine exposes no update/delete path for audit rows.

## Programmatic use

The subsystem is wired into `createEngine` automatically when enabled. For direct control:

```ts
import { createAudit, createBufferedAuditSink } from '@weave-kit/engine';

const store = await createAudit(pool);                                   // storage
const sink = createBufferedAuditSink(store, { batchSize: 50, flushMs: 100 });  // L1 buffer
await sink.record({ actorType: AUDIT_ACTOR_TYPES.SYSTEM, actorId: 'system', action: DATA_ACTIONS.CREATE, objectName: 'lead', objectId: 'L1', timestamp: new Date() });
await sink.flush();
```

## Next

- [Custom tools & guardrails](custom-tools-and-guardrails.md) — audit diff replay (`before`/`after` snapshots, `subsystems.audit.replay`)
- [MCP](mcp.md) — `mcp.tool.<name>` tool-call events (agent on-behalf-of in `meta.onBehalfOf`)
- [RBAC](rbac.md) — what the denied events record

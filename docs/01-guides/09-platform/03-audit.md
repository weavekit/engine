---
title: "Audit"
description: "The audit subsystem records immutable events for every data mutation (and every read denial) at one uniform boundary: the data-access layer."
---
# Audit

The audit subsystem records immutable events for every data mutation (and every read denial) at one
uniform boundary: the data-access layer. REST, MCP, and any interface you add later inherit it
automatically, with zero per-interface code.

Audit is an **optional subsystem**. It is disabled by default, and when it is off it isn't loaded at
all — no import, no table, no queries.

## Enable

tttts
// weavekit.config.ts
export default {
  // ...
  subsystems: {
    audit: {
      enabled: true,
      mode: 'best-effort',                       // 'best-effort' | 'transactional' | 'durable'
      batch: { batchSize: 50, flushMs: 100 },    // optional; defaults shown (best-effort mode)
    },
  },
};
ttt

tmodet selects durability: tbest-effortt (default) is a fire-and-forget process buffer (a crash may
lose the tail); ttransactionalt writes the audit row inside the business transaction; tdurablet
writes a transactional outbox row + relay (crash-safe, at-least-once). ttransactionalt/tdurablet
require an in-transaction sink — the built-in sinks provide it; if a custom sink cannot,
startup fails unless you set tallowBestEffortFallback: truet. Storage growth, retention, export
and compliance are product/enterprise concerns; the engine only captures.

**In production, prefer ttransactionalt (or tdurablet)** so a crash cannot lose audit events. The
tgovernancet starter preset scaffolds taudit: { enabled: true, mode: 'transactional' }t for you;
the tagentt / tservicet / tbusinesst presets leave audit off — turn it on and pick a crash-safe mode
before going live.

## What gets audited automatically

Because events are recorded at the **data-access boundary**, every tcreatet / tupdatet / tdeletet
through REST, MCP tools, or a host call produces an event — **including failures**:

| Event | When |
| --- | --- |
| tcreatet | record created (success) |
| tcreatet (isError) | validation failed, e.g. tdata.field.requiredt |
| tupdatet | record updated (success) |
| tupdatet (isError) | RBAC denial (trbac.denied.updatet / trbac.denied.fieldt) or record not found |
| tdeletet | record deleted (success) |
| tdeletet (isError) | RBAC denial or record not found |
| treadt (isError) | read denied (trbac.denied.readt) |

Failed and denied operations are audit highlights — they are exactly the attempts you want to review.

## Event model

tttts
interface AuditEvent {
  actorType: 'user' | 'system' | 'agent' | 'anonymous';  // AUDIT_ACTOR_TYPES
  actorId: string;          // subject.id, or 'system', or agent key
  action: string;           // DATA_ACTIONS (create/update/delete/read) or '<prefix>.<detail>'
  objectName?: string;      // object name
  objectId?: string;        // record_key (external id)
  changes?: unknown;        // write payload / change summary
  isError?: boolean;
  errorCode?: string;       // engine SchemaError code, e.g. 'rbac.denied.field'
  meta?: Record<string, unknown>;  // e.g. agent on-behalf-of
  timestamp: Date;          // the business moment, not the flush time
}
ttt

The enum-like fields are backed by tas constt constants exported from the engine:

- tAUDIT_ACTOR_TYPESt — tAGENT / USER / SYSTEM / ANONYMOUSt
- tDATA_ACTIONSt — tCREATE / UPDATE / DELETE / READt
- tACTION_PREFIXESt — tMCP_TOOL ('mcp.tool')t, tREST ('rest')t; interface-layer actions compose as t<prefix>.<detail>t

## Querying

tengine.auditt is available when the subsystem is enabled:

tttts
const engine = await createEngine({ /* ... */, subsystems: { audit: { enabled: true } } });

const { rows, total } = await engine.audit.query({
  actorId: 'u100',
  action: DATA_ACTIONS.UPDATE,
  object: 'lead',
  from: new Date('2026-08-01'),
  to: new Date(),
  limit: 50,
  offset: 0,
});
// rows are AuditEvent[], ordered ts DESC
ttt

For stable, offset-free paging over a growing trail, use the **keyset cursor**: pass the
tnextCursort from one page back as tcursort (it walks t(ts DESC, id DESC)t, so concurrent inserts
never duplicate or skip a row). toffsett is ignored in cursor mode; an invalid cursor is a
thttp.param.invalidt (400).

tttts
const page1 = await engine.audit.query({ action: DATA_ACTIONS.UPDATE, limit: 50 });
const page2 = await engine.audit.query({ action: DATA_ACTIONS.UPDATE, limit: 50, cursor: page1.nextCursor! });
ttt

Over REST the same contract is tGET {prefix}/audit?…&limit&offset&cursort → t{ rows, total, limit,
offset, nextCursor? }t. The **evidence** stream (tevidence.enabledt) exposes the same shape through
tqueryEvidence({ action, objectName, subjectId, actorKey, isError, from, to, limit, offset, cursor })t.
Export / retention / compliance reporting remain enterprise E2.

## Buffering semantics (fire-and-forget)

trecord()t queues the event in memory and returns immediately, so **audit never blocks the business
critical path** — which matters under concurrent, multi-user load. Events flush as a single
multi-row tINSERTt when the batch fills (tbatchSizet) or the flush window elapses (tflushMst).

- tengine.close()t flushes the remaining buffer before the pool shuts down.
- A process crash loses only the most recent, not-yet-flushed events (audit is best-effort).
- Batch-write failures call tonErrort (default tconsole.errort) and never throw into the caller.
- The stored ttimestampt is the business moment, so delayed flushing does not distort the trail.

## Table

ttt
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
ttt

The table is append-only by contract: the engine exposes no update or delete path for audit rows.

## Programmatic use

tcreateEnginet wires the subsystem in automatically when enabled. For direct control:

tttts
import { createAudit, createBufferedAuditSink } from '@weave-kit/engine';

const store = await createAudit(pool);                                   // storage
const sink = createBufferedAuditSink(store, { batchSize: 50, flushMs: 100 });  // L1 buffer
await sink.record({ actorType: AUDIT_ACTOR_TYPES.SYSTEM, actorId: 'system', action: DATA_ACTIONS.CREATE, objectName: 'lead', objectId: '2:L1', timestamp: new Date() });
await sink.flush();
ttt

## Related
- [Custom tools & guardrails](../05-agents/03-custom-tools-and-guardrails/01-overview.md) — audit diff replay (tbeforet/taftert snapshots, tsubsystems.audit.replayt)
- [MCP](../05-agents/02-mcp/01-overview.md) — tmcp.tool.<name>t tool-call events (agent on-behalf-of in tmeta.onBehalfOft)
- [RBAC](../04-access/02-rbac.md) — what the denied events record
- [Multi-tenancy](../04-access/04-multi-tenancy.md) — ttenant_idt scoping of the trail
- [Observability](05-observability.md) — ttraceIdt (W3C ttraceparentt) on events
- [Execution & evidence](../05-agents/05-execution-and-evidence.md) — the write/tool pipeline and tweavekit_evidencet

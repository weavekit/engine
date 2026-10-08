---
title: Execution & evidence
description: "Every write and tool call runs through one pipeline — and can leave a correlatable evidence record."
---

# Execution & evidence

Writes and tool calls used to be guarded in different places. Now they share **one protocol-agnostic
pipeline** so guardrails and approvals apply identically to REST, MCP, GraphQL, script and custom
tools — and each execution can leave a single **evidence** record.

## Stages

```
Plan → Validate → Authorize → Guardrail → Approval → Execute → Commit → Evidence
```

`EXECUTION_STAGES` is the single-source list. `runPipeline(plan, ctx, deps)` runs one execution and
records every stage outcome; a `deny`/`pending` short-circuits `execute`.

- **Plan / Validate** — a `ExecutionPlan` (`action`, `objectName?`, `objectId?`, `args`, `intent?`);
  tool arguments are validated against the declared `ToolJsonSchema` (`validateToolArgs`).
- **Authorize / Guardrail / Approval** — RBAC plus the guardrail policy set; a policy may require
  approval (enqueued in the [approvals queue](04-approvals.md)).
- **Execute / Commit** — the work, owning its own transaction.
- **Evidence** — the recorded record (below).

The pipeline drives two choke points: the **data-access write path** (`create`/`update`/`delete` /
workflow transition, action `object.<obj>.<op>`) and the **custom-tool executor** (action
`mcp.tool.<name>`). Because every protocol ends at data-access, guardrails/approvals/evidence cover
all of them from one place.

## Evidence

Enable it to record one `weavekit_evidence` row per gated execution:

```ts
// weavekit.config.ts
export default { /* ... */ evidence: { enabled: true } };
```

An `Evidence` (`core/tools/pipeline.ts`) carries the correlation ids (`requestId`, `traceId`,
`schemaRevision`), the `actor`, `subjectId`, the `plan`, the per-stage `stages` timeline, plus
`approvalKey` / `isError` / `errorCode` and the timestamp. `EvidenceSink.record` is the seam; the
engine ships the PG sink (`subsystems/evidence`).

Read it back with the same stable pagination contract as the audit trail:

```ts
import { queryEvidence } from '@weave-kit/engine';

const page1 = await queryEvidence(pool, { action: 'mcp.tool.search_records', limit: 50 });
const page2 = await queryEvidence(pool, { limit: 50, cursor: page1.nextCursor! });
```

`EvidenceQuery` filters by `action` / `objectName` / `subjectId` / `actorKey` / `isError` / `from` /
`to` and pages by `limit` + `offset` **or** a keyset `cursor` over `(ts DESC, id DESC)`; a malformed
cursor is a `http.param.invalid` (400). Rows are newest-first.

## Correlation

`requestId` (HTTP request id), `traceId` (parsed W3C `traceparent`) and `schemaRevision` link one
execution to the request, the [audit trail](../09-platform/03-audit.md) and the applied schema
revision — so an agent action is traceable across API, audit and evidence. See
[Observability](../09-platform/05-observability.md).

## Scope boundary

The engine only **captures** evidence. Export, retention policy and compliance reporting are the
enterprise E2 layer.

## Related
- [Custom tools & guardrails](03-custom-tools-and-guardrails/01-overview.md) — the open contract the pipeline drives
- [Approvals](04-approvals.md) — the human-in-the-loop step
- [Audit](../09-platform/03-audit.md) · [Observability](../09-platform/05-observability.md)
- [Public API](../../04-reference/01-api/02-public-api.md) — `runPipeline` / `Evidence` / `queryEvidence`

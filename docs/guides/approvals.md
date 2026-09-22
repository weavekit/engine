# Approvals

Approvals add a **human-in-the-loop** step in front of a tool call. A guardrail policy can return a
`requireApproval` decision instead of `allow`/`deny`; the call is suspended, an approver resolves it,
and the outcome decides whether the call proceeds. See
[Custom tools, guardrails & audit replay](custom-tools-and-guardrails.md) for the policy pipeline.

## Flow

1. A guardrail policy's `decide()` returns:

   ```ts
   { allow: false, requireApproval: true, approvalKey: 'approve-big-order' }
   ```

2. The call is suspended; the caller gets `isError` with `mcp.approval.pending` and the `approvalKey`.
   The pending entry is stored in the **approval queue**.
3. An admin approves or rejects it (REST below). Resolution is recorded against the approver.
4. On the next call with the same `approvalKey`, the policy can read the queue through `ctx.approvals`
   and allow it.

The queue carries request **arguments**, so every endpoint is gated to `adapters.rest.adminRoles` —
reading it is a write-authority boundary, not a read anyone gets.

## The queue

A `PendingApproval` is `{ approvalKey, action, args, status, createdAt, actorKey, approvedBy? }`, with
statuses `pending` / `approved` / `rejected`.

Backends implement `ApprovalsBackend`:

- **In-memory** (`core/tools`) — the default and the test double.
- **PostgreSQL** (`subsystems/approvals`) — the persisted store; enable it in config to survive
  restarts. The store never audits; resolution audit belongs to the queue facade.

Tool handlers reach it through `ctx.approvals` (`list`, `count`, `query`, `approve`, `reject`).

## REST

```
GET  {prefix}/approvals                      paged list
POST {prefix}/approvals/:key/approve         resolve → approved   (admin)
POST {prefix}/approvals/:key/reject          resolve → rejected   (admin)
```

`GET` supports `status`, `action`, `actorKey`, `from`, `to` (createdAt window), `limit`, `offset` and
`sort`/`order` (default `createdAt` DESC). It returns `{ rows, total, limit, offset }`. Approve/reject
return `{ approvalKey, status, approver }` and answer `approval.notFound` when the key is unknown or
already resolved.

## Enable

The routes are registered when the **tool executor is enabled** (`tools.toolsDir` is set). The queue
defaults to the **PostgreSQL** backend (`subsystems/approvals`, the engine's mandated DB); opt out with
an in-process queue:

```ts
export default {
  tools: {
    toolsDir: 'tools',
    approvals: { backend: 'memory' }, // default is the persisted PG backend
  },
};
```

When the executor is off, the approval routes are absent — no import, zero overhead.

## Next

- [Custom tools, guardrails & audit replay](custom-tools-and-guardrails.md) — where `requireApproval` comes from
- [Audit](audit.md) — how resolutions are recorded

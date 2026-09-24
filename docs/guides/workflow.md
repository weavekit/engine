# Workflow

A **workflow** is a declarative state machine for one object. Each record sits in a named state and
moves between states only through declared **transitions**. Put this in `objects/<name>/workflow.json`
next to `schema.json`:

```json
{
  "initial": "draft",
  "stateField": "status",
  "states": [{ "name": "draft" }, { "name": "pending" }, { "name": "approved" }],
  "transitions": [
    { "action": "submit", "from": "draft", "to": "pending" },
    { "action": "approve", "from": "pending", "to": "approved", "roles": ["manager"] }
  ]
}
```

`stateField` must name a **single-valued `enum` field** on the object, and its `options` must list
every state. New records start in `initial`. The state field is engine-managed: it is **read-only**
except through a transition, so the machine can never be bypassed by a plain
`PATCH`/`update_record`.

Add labels for display names and an optional role gate per transition:

```json
{
  "name": "pending",
  "labels": { "en": "Pending review", "zh": "待审核" }
}
```

```json
{ "action": "approve", "from": "pending", "to": "approved", "roles": ["manager"] }
```

```json
{ "action": "publish", "from": "approved", "to": "published", "requiresApproval": true }
```

- **`roles`** (transition-level) restricts who may fire it; when omitted, any identity allowed to
  update the object may fire it.
- **`requiresApproval: true`** holds the transition until it is approved (see below).
- **Audit & live events** — every transition is recorded as a `transition` audit event (with the
  `action`, `from` and `to`) and published on the live channel as `record.transitioned`
  (`{ object, id, from, to, action }`), alongside the generic `record.updated`.

## Guardrails and approvals

When the [open contract](custom-tools-and-guardrails.md) is enabled (`config.tools`), its guardrail
policies and approval queue also apply to transitions. The engine passes
`ctx.action = workflow.transition.<object>.<action>`, so a policy self-filters:

```ts
export default {
  name: 'no-big-refunds',
  decide(ctx) {
    if (!ctx.action.startsWith('workflow.transition.')) return { allow: true };
    return { allow: false, requireApproval: true, approvalKey: 'refund-approval' };
  },
};
```

- A `deny` decision fails the transition with `400 mcp.policy.denied`.
- A `requireApproval` decision (or a transition's own `requiresApproval: true`) suspends it: the
  caller gets `409 workflow.transition.pending` with an `approvalKey`; an admin approves it through
  the [approval queue](approvals.md), and the caller retries the same transition.
- If a transition requires approval but no approval queue is configured, it **fails closed**
  (`workflow.approval.unavailable`) rather than firing.

## Hooks

If the [script subsystem](script-hooks.md) is enabled, an object can react to transitions in
`objects/<name>/server.js`:

| Hook | When | `this` |
| --- | --- | --- |
| `beforeTransition` | inside the transaction, before the write | `this.transition` (`{ from, to }`), `this.state` (target); may **return changes** to persist with the new state |
| `afterTransition` | after commit | `this.transition`, `this.state` (target) |
| `onExit` | after commit, when leaving a state | `this.state` (the state being left) |
| `onEnter` | after commit, when entering a state | `this.state` (the state entered) |

A `beforeTransition` throw aborts the transition (the state is unchanged); `afterTransition` /
`onEnter` / `onExit` throws are non-fatal warnings (the transition is already committed).

```js
// objects/ticket/server.js
export function onEnter() {
  if (this.state === 'approved') this.changes.approved_at = new Date().toISOString();
  return this.changes;
}
```

## REST

```
GET  {prefix}/objects/:name/:id/workflow              → { state, initial, actions: [{ action, to, labels? }] }
POST {prefix}/objects/:name/:id/transitions/:action   → the updated record
```

`actions` lists only the transitions fireable from the record's current state by the caller's roles —
ideal for rendering the available buttons. `POST` returns `404 workflow.transition.unknown` for an
unknown action, `409 workflow.transition.notAllowed` when the action exists but not from the current
state, and `403 workflow.transition.denied` when the caller's roles are not permitted.

## Permissions

A transition runs through the same RBAC as `update`: the identity needs an `update` permission on the
object and is scoped to the rows it may read. `roles` on a transition is an additional, tighter gate.
Writing the state field directly (via `PATCH` or a script/tool) fails with
`400 workflow.transition.required`.

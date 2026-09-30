---
title: Context API
description: "What this exposes inside a hook: record, changes, user, db.objects and restricted SQL."
---

# Context API

Everything a hook touches goes through `this`.

| Property | Type | Notes |
| --- | --- | --- |
| `this.record` | object \| null | current record pre-write; `null` on create |
| `this.changes` | object | fields being written (return it from `beforeUpdate` to persist) |
| `this.user` | `{ id, roles }` | who triggered the operation (from the authenticated subject) |
| `this.db.objects(name)` | builder | `find / findOne / create / update / delete` — **RBAC-enforced** (runs through `withRbac`) |
| `this.db.query(sql, params)` | function | restricted SQL — see below |
| `this.services` | object | `email.send` / `slack.post` / `webhook.call` — **bridged to the engine process**, no sandbox networking |
| `this.transition` / `this.state` | `null` | reserved for workflow hooks |
| `this.records` | array | `onLoad` only — the whole loaded batch |

`this.db.objects` is the normal path — it goes through the same RBAC and row scopes as the REST/MCP
surface (id + roles; `departmentId` isn't carried into scripts).

## Restricted SQL (`this.db.query`)

A controlled escape hatch for queries the object builder can't express. Every call is parsed with
**PostgreSQL's own parser** (`pgsql-parser` / `libpg-query`, WASM) and gated before execution:

- **SELECT-only** — anything else is rejected (`script.query.invalid`, fail-closed on any parse failure).
- **Single statement** — a `;` beyond one trailing is rejected.
- **Row cap** — the query is wrapped in a subquery and the outer `LIMIT` is clamped to 1000.
- **Timeout** — runs on a dedicated client with `statement_timeout = queryTimeout`.
- **RBAC gates** (`script.query.denied`, 403) — the subject must have read permission on every
  referenced table. `department`-read objects require `subject.departmentId`. **Column-level
  `exclude`** is enforced per column: a query referencing an excluded field (or `*` over a
  field-restricted object) is rejected. `count(*)` is allowed (no values leak).
- **Row-level security (PostgreSQL RLS)** — with the script subsystem on, `db.query` runs in a
  transaction under `SET LOCAL ROLE weavekit_query` with `weavekit.actor_id/roles/department_id`
  session GUCs, so the table's RLS policy scopes rows like `db.objects` (parity is tested). RLS
  predicates are **flat equality on internal ids** — they don't expand the department subtree or
  translate external scope columns; use `db.objects` for those. `weave migrate` provisions the role and
  emits `ENABLE ROW LEVEL SECURITY` + the policy + `GRANT SELECT` automatically.

Field-level `exclude` hiding is **not** bypassable via raw SQL: a query that touches a restricted
column is rejected rather than stripped.

## Related

- [Authoring hooks](02-authoring.md) — the hook list and examples
- [Sandbox & errors](04-sandbox.md)
- [RBAC](../../04-access/02-rbac.md)

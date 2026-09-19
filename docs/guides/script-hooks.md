# Script subsystem

The script subsystem executes user-authored `server.js` lifecycle hooks from `objects/<name>/server.js` in an **isolated sandbox**. Hooks run around data writes — validation, pre-write mutation, post-write side effects — and are bridged back to the engine for any data/service access.

Script is an **optional subsystem**: disabled by default, and when disabled it is not loaded at all (no import, no workers, zero overhead).

> **Optional native dependency**: the sandbox backend uses `isolated-vm`, declared as an `optionalDependency`.
> Users who do not enable the script subsystem never install or load it. If it is missing at startup while the
> subsystem is enabled, the engine fails fast with `script.sandbox.unavailable` (install with
> `npm install isolated-vm`) instead of a raw module error.

> Client-side `client.js` is a **frontend** concern (runs in the browser under same-origin). The engine does not load or execute it; the loader simply ignores `.client.js` files.

## Enable

```ts
// weavekit.config.ts
export default {
  // ...
  subsystems: {
    script: {
      enabled: true,
      sandbox: {
        timeout: 5000,                 // overall hook timeout (ms)
        queryTimeout: 2000,            // per this.db call timeout (ms)
        memoryLimit: 64 * 1024 * 1024, // sandbox heap limit (bytes)
        maxConcurrentScripts: 10,      // concurrent hook executions (over → script.busy)
        maxObjectsPerQuery: 100,       // rows a script may fetch per db.objects(...).find() (clamped; global cap is 1000)
        rls: { role: 'weavekit_query' }, // db.query row-level security role (on by default when script enabled)
      },
      // services: { ... }             // optional: custom this.services implementations
    },
  },
};
```

## Hooks

Hooks are **exported functions**, invoked with no arguments; everything is accessed through `this`. Unknown exports are ignored (you may keep helper functions).

| Hook | Phase | Runs | Throw → |
| --- | --- | --- | --- |
| `onLoad` | read | `find` / `findOne`, and the record returned by `create`/`update` — receives `this.records` (whole batch) and **returns an equal-length array** (or `undefined` to keep); length mismatch aborts | **abort** (400) |
| `validate` | before write | declarative schema checks + RBAC have passed | **abort** (PG untouched, 400) |
| `beforeUpdate` | before write | may rewrite `this.changes`; **return** the changes to persist | **abort** |
| `beforeDelete` | before write | may check related data | **abort** |
| `afterUpdate` | after commit | side effects (notify, touch related records) | warning |
| `afterDelete` | after commit | cleanup / logging | warning |

Workflow hooks (`beforeTransition` / `afterTransition` / `onEnter` / `onExit` / `onTimeout`) are defined in the contract (`SCRIPT_HOOKS`) and will be wired when the workflow subsystem ships.

**`onLoad`** is the read hook: it runs when records are loaded and can decorate/redact them per the current user. It receives the whole batch as `this.records`, mutates it (or builds a copy), and **returns an equal-length array** (or `undefined` to keep the batch unchanged). `this.record` is `null` and `this.changes` is `{}`. It is a **transform-only** hook — the set of returned rows is fixed (RLS + filter + pagination decide membership), so `total` stays accurate; returning a different-length array is an error (`400 script.abort`). It fires for `find`, `findOne`, and the record returned by `create`/`update` (so `POST`/`PATCH` responses match `GET`). Re-entrant reads of the same object inside the hook skip `onLoad` to avoid recursion.

```js
// objects/lead/server.js
export function onLoad() {
  for (const r of this.records) {
    if (this.user.roles.includes('sales')) delete r.secret;   // redact per user
    r.canApprove = r.amount > 5000;                            // decorate
  }
  return this.records;
}
```

```js
// objects/lead/server.js
export function validate() {
  if (this.changes.amount !== undefined && this.changes.amount <= 0) {
    throw new Error('amount must be > 0');     // → 400, write aborted
  }
}

export function beforeUpdate() {
  if (this.changes.title) {
    this.changes.title = String(this.changes.title).toUpperCase();
  }
  return this.changes;                         // persist the modified changes
}

export async function afterUpdate() {
  await this.db.objects('audit_log').create({ id: 'a-' + this.record.id, message: 'updated' });
  // throw → write already committed; the error becomes a warning on the response
}
```

### `this` context

| Property | Type | Notes |
| --- | --- | --- |
| `this.record` | object \| null | current record pre-write; `null` on create |
| `this.changes` | object | fields being written |
| `this.user` | `{ id, roles }` | who triggered the operation (from the authenticated subject) |
| `this.db.objects(name)` | builder | `find / findOne / create / update / delete` — **RBAC-enforced** (runs through `withRbac`) |
| `this.db.query(sql, params)` | function | restricted SQL — see below |
| `this.services` | object | `email.send` / `slack.post` / `webhook.call` — **bridged to the engine process**, no sandbox networking |
| `this.transition` / `this.state` | `null` | reserved for workflow hooks |

## Isolation

Each `server.js` runs in its **own worker thread** hosting its own **V8 isolate** (`isolated-vm`): real heap isolation — the sandbox has no reachable host capability globals (`require` / `process` / `fetch` / `setTimeout` / `eval` / `Function` escapes all resolve to `undefined` inside the isolate). `db` / `services` / `console` are **synchronous Callbacks** whose implementations bridge to the engine main process over a `SharedArrayBuffer` + `Atomics.wait/notify` channel: the sandbox posts an RPC, the main process runs the async data-access/providers, and the sandbox resumes synchronously.

- **Memory** — `ivm.Isolate({ memoryLimit })` from `sandbox.memoryLimit`.
- **Timeout** — CPU-bound loops (`while(true)`) are killed by the isolate eval timeout; a dead/expired sandbox is destroyed (isolate disposed, worker terminated) and re-spawned on next use, so one bad script never poisons later calls.
- **Concurrency** — `maxConcurrentScripts` (over the cap → `script.busy`, fail-fast; no queueing so nested script calls cannot deadlock).
- **Pending async is detected, not silently dropped** — `evalClosure` returns `undefined` as soon as the synchronous execution yields (isolated-vm drops the settled value of a promise proxy), so hook completion is tracked with an in-isolate `__done` sentinel: a hook that is still logically pending when `evalClosure` returns (e.g. `await new Promise(()=>{})`) is reported as a **timeout** and the sandbox is destroyed (lazily re-spawned), instead of silently succeeding with `undefined`. Hooks that await the (synchronous) `db`/`services` calls resolve deterministically.

## Restricted SQL (`this.db.query`)

A controlled escape hatch for queries the object builder cannot express. Every call is parsed with **PostgreSQL's own parser** (`pgsql-parser` / `libpg-query`, WASM) and gated before execution:

- **SELECT-only** — anything else is rejected (`script.query.invalid`, fail-closed on any parse failure)
- **single statement** — a `;` (beyond one trailing) is rejected
- **row cap** — the query is wrapped in a subquery and the outer `LIMIT` is clamped to 1000
- **timeout** — runs on a dedicated client with `statement_timeout = queryTimeout`
- **RBAC gates** (`script.query.denied`, 403) — the subject must have read permission on every referenced object table; `team`-read objects require `subject.teamId`; **column-level `exclude`** is enforced per column: a query referencing an excluded field (or `*` over a field-restricted object) is rejected. `count(*)` is allowed (no column values leak).
- **row-level security (PostgreSQL RLS)** — with the script subsystem enabled, `db.query` runs in a transaction under `SET LOCAL ROLE weavekit_query` with `weavekit.actor_id/roles/team_id` session GUCs, so the table's RLS policy scopes the returned rows exactly like `db.objects` (parity is tested). `weave migrate` provisions the role and emits `ENABLE ROW LEVEL SECURITY` + the policy + `GRANT SELECT` automatically.

The `exclude` field-level hiding is **not** bypassable via raw SQL: queries touching a restricted column are rejected rather than stripped.

## Error semantics

| Where | Behavior |
| --- | --- |
| `validate` / `beforeUpdate` / `beforeDelete` throw | write **aborts** — PG untouched; REST returns `400 script.abort` with the hook message |
| sandbox timeout / crash | write aborts; `script.timeout` (500) |
| `afterUpdate` / `afterDelete` throw | write **already committed**; the message is delivered via `ctx.onWarnings` and **appended as a `warnings` array on the REST response** (`POST`/`PATCH`); `DELETE` (204) has no body, so it is recorded to **audit** only |
| compile error in `server.js` | `script.compile` on first dispatch (500) — the file is loaded lazily |

## Scoping decisions

- **Validate hook order** — the engine runs `RBAC → declarative validation → validate hook → beforeUpdate hook → write → afterUpdate hook`. (Running validation after RBAC is strictly safer and keeps a single decorator-free data-access path.)
- **`beforeUpdate` writes** — `this.changes` is structured-cloned into the sandbox, so mutation alone does not propagate; the hook must **return** the (possibly modified) changes object to persist them.
- **`db.objects` RBAC** — script calls rebuild the caller's identity as an `RbacSubject` (id + roles; teamId is not carried, so team-scoped reads inside scripts are not available).

## Programmatic use

```ts
import { createScriptDispatcher } from '@weave-kit/engine';
import { createDataAccess, createPool, ObjectRegistry } from '@weave-kit/engine';

const dispatcher = await createScriptDispatcher({
  objectsDir: join(projectRoot, 'objects'),
  registry,
  pool,
  dataAccess,                       // RBAC-decorated — serves this.db.objects
  config: { sandbox: { timeout: 5000, queryTimeout: 2000 } },
});
const dataAccess = createDataAccess({ script: dispatcher }); // hooks now fire on writes
// ...
await dispatcher.close();           // terminates all workers
```

## Client scripts (`*.client.js`)

Frontend logic is delivered, not executed. All object script source uses one endpoint:

```
GET {prefix}/objects/:name/scripts/:kind
```

`kind` is `show.client` or `list.client` for browser hooks; the response is `{ source, version }` and requires Bearer authentication. `@weave-kit/client` fetches through `client.scripts.getSource(name, kind)`; `@weave-kit/ui` owns browser execution and binds hooks to one resource instance. The engine returns 404 for an unknown object or missing file and never interprets client scripts. This preserves the Headless boundary: no UI rendering or browser behavior executes server-side.

### Admin source editing

Desk editors use the same source API:

```
GET {prefix}/objects/:name/scripts/:kind
PUT {prefix}/objects/:name/scripts/:kind
```

`kind` is `server`, `show.client`, or `list.client`. GET returns `{ source, version }`; PUT accepts `{ source, expectVersion? }` and returns `{ ok, committed, version, warnings? }`. Client kinds are readable by any authenticated identity so runtime hooks can load. Reading `server` and every PUT require a role listed in `adapters.rest.adminRoles`; when that list is absent, those admin operations fail closed.

PUT parses JavaScript without executing it and requires server hooks to use the documented parameterless `this` signature. A changed source is atomically written to `objects/<name>/<kind>.js` and committed as the only path in a Git commit; unrelated staged work remains staged. A Git failure restores the prior file. Missing files may be created, and an empty source is valid. `expectVersion` is accepted for forward compatibility; the write remains last-write-wins.

## Next

- [Audit](audit.md) — after-hook failures are recorded as `isError` events
- [RBAC](rbac.md) — the permissions `this.db.objects` enforces

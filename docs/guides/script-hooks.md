# Script subsystem

The script subsystem runs user-authored `server.js` lifecycle hooks from `objects/<name>/server.js`
in an **isolated sandbox**. Hooks run around data writes — validation, pre-write mutation, post-write
side effects — and are bridged back to the engine for any data or service access.

Script is an **optional subsystem**. It is disabled by default, and when it is off it isn't loaded at
all: no import, no workers, zero overhead.

> **Optional native dependency**: the sandbox backend uses `isolated-vm`, declared as an
> `optionalDependency`. If you don't enable the script subsystem, it is never installed or loaded. If
> it is missing at startup while the subsystem is enabled, the engine fails fast with
> `script.sandbox.unavailable` (install with `npm install isolated-vm`) instead of a raw module error.

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

Hooks are **exported functions**, invoked with no arguments. Everything is accessed through `this`.
Unknown exports are ignored, so you can keep helper functions in the file.

| Hook | Phase | Runs | Throw → |
| --- | --- | --- | --- |
| `onLoad` | read | `find` / `findOne`, and the record returned by `create`/`update` — receives `this.records` (whole batch) and **returns an equal-length array** (or `undefined` to keep); length mismatch aborts | **abort** (400) |
| `validate` | before write | declarative schema checks + RBAC have passed | **abort** (PG untouched, 400) |
| `beforeUpdate` | before write | may rewrite `this.changes`; **return** the changes to persist | **abort** |
| `beforeDelete` | before write | may check related data | **abort** |
| `afterUpdate` | after commit | side effects (notify, touch related records) | warning |
| `afterDelete` | after commit | cleanup / logging | warning |

The `SCRIPT_HOOKS` contract also defines workflow hooks (`beforeTransition` / `afterTransition` /
`onEnter` / `onExit` / `onTimeout`); they are not currently dispatched.

**`onLoad`** is the read hook. It runs when records are loaded and can decorate or redact them for the
current user. It receives the whole batch as `this.records`, mutates it (or builds a copy), and
**returns an equal-length array** (or `undefined` to keep the batch unchanged). `this.record` is
`null` and `this.changes` is `{}`.

`onLoad` is a **transform-only** hook: the returned rows are fixed (RLS + filter + pagination decide
membership), so `total` stays accurate, and returning a different-length array is an error
(`400 script.abort`). It fires for `find`, `findOne`, and the record returned by `create`/`update`, so
`POST`/`PATCH` responses match `GET`. Re-entrant reads of the same object inside the hook skip
`onLoad` to avoid recursion.

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

Each `server.js` runs in its **own worker thread** hosting its own **V8 isolate** (`isolated-vm`), so
it gets real heap isolation: the sandbox has no reachable host-capability globals (`require`,
`process`, `fetch`, `setTimeout`, `eval`, and `Function` escapes all resolve to `undefined` inside the
isolate).

`db`, `services`, and `console` are **synchronous Callbacks** whose implementations bridge to the
engine main process over a `SharedArrayBuffer` + `Atomics.wait/notify` channel: the sandbox posts an
RPC, the main process runs the async data-access or provider call, and the sandbox resumes
synchronously.

- **Memory** — `ivm.Isolate({ memoryLimit })` from `sandbox.memoryLimit`.
- **Timeout** — CPU-bound loops (`while(true)`) are killed by the isolate eval timeout. A dead or expired sandbox is destroyed (isolate disposed, worker terminated) and re-spawned on next use, so one bad script never poisons later calls.
- **Concurrency** — `maxConcurrentScripts`; over the cap fails fast with `script.busy` (no queueing, so nested script calls cannot deadlock).
- **Pending async is detected, not silently dropped** — `evalClosure` returns `undefined` as soon as synchronous execution yields (isolated-vm drops the settled value of a promise proxy), so hook completion is tracked with an in-isolate `__done` sentinel. A hook still logically pending when `evalClosure` returns (e.g. `await new Promise(()=>{})`) is reported as a **timeout** and the sandbox is destroyed (lazily re-spawned), instead of silently succeeding with `undefined`. Hooks that await the (synchronous) `db`/`services` calls resolve deterministically.

## Restricted SQL (`this.db.query`)

A controlled escape hatch for queries the object builder cannot express. Every call is parsed with
**PostgreSQL's own parser** (`pgsql-parser` / `libpg-query`, WASM) and gated before execution:

- **SELECT-only** — anything else is rejected (`script.query.invalid`, fail-closed on any parse failure).
- **Single statement** — a `;` beyond one trailing is rejected.
- **Row cap** — the query is wrapped in a subquery and the outer `LIMIT` is clamped to 1000.
- **Timeout** — runs on a dedicated client with `statement_timeout = queryTimeout`.
- **RBAC gates** (`script.query.denied`, 403) — the subject must have read permission on every referenced object table. `team`-read objects require `subject.teamId`. **Column-level `exclude`** is enforced per column: a query referencing an excluded field (or `*` over a field-restricted object) is rejected. `count(*)` is allowed (no column values leak).
- **Row-level security (PostgreSQL RLS)** — with the script subsystem enabled, `db.query` runs in a transaction under `SET LOCAL ROLE weavekit_query` with `weavekit.actor_id/roles/team_id` session GUCs, so the table's RLS policy scopes the returned rows exactly like `db.objects` (parity is tested). `weave migrate` provisions the role and emits `ENABLE ROW LEVEL SECURITY` + the policy + `GRANT SELECT` automatically.

Field-level `exclude` hiding is **not** bypassable via raw SQL: a query that touches a restricted
column is rejected rather than stripped.

## Error semantics

| Where | Behavior |
| --- | --- |
| `validate` / `beforeUpdate` / `beforeDelete` throw | write **aborts** — PG untouched; REST returns `400 script.abort` with the hook message |
| sandbox timeout / crash | write aborts; `script.timeout` (500) |
| `afterUpdate` / `afterDelete` throw | write **already committed**; the message is delivered via `ctx.onWarnings` and **appended as a `warnings` array on the REST response** (`POST`/`PATCH`); `DELETE` (204) has no body, so it is recorded to **audit** only |
| compile error in `server.js` | `script.compile` on first dispatch (500) — the file is loaded lazily |

## Scoping decisions

- **Validate hook order** — the engine runs `RBAC → declarative validation → validate hook → beforeUpdate hook → write → afterUpdate hook`. Running validation after RBAC is strictly safer and keeps a single decorator-free data-access path.
- **`beforeUpdate` writes** — `this.changes` is structured-cloned into the sandbox, so mutation alone does not propagate. The hook must **return** the (possibly modified) changes object to persist them.
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

## Editing `server.js` over the API

Admin tooling can read and write the hook source through the REST API:

```
GET {prefix}/objects/:name/scripts/server
PUT {prefix}/objects/:name/scripts/server
```

GET returns `{ source, version }`; PUT accepts `{ source, expectVersion? }` and returns
`{ ok, committed, version }`.

- **Access** — both operations require a role listed in `adapters.rest.adminRoles`; when that list is
  absent they fail closed.
- **Validation** — PUT parses the JavaScript without executing it and requires the documented
  parameterless `this` signature; an invalid source is rejected with `400`.
- **Write** — the source is written atomically to `objects/<name>/server.js` and committed as the only
  path in a Git commit; unrelated staged work stays staged, and a Git failure restores the prior file.
  Missing files may be created, and an empty source is valid. `expectVersion` is accepted for forward
  compatibility; the write remains last-write-wins.

The commit behavior is covered in [Git-versioned metadata](git-versioned-metadata.md).

## Next

- [Audit](audit.md) — after-hook failures are recorded as `isError` events
- [RBAC](rbac.md) — the permissions `this.db.objects` enforces

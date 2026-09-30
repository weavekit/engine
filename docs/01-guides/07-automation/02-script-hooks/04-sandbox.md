---
title: Sandbox & errors
description: "How hooks are isolated, capped, and what happens when they fail."
---

# Sandbox & errors

## Isolation

Each `server.js` runs in its **own worker thread** hosting its own **V8 isolate** (`isolated-vm`), so
it gets real heap isolation: the sandbox has no reachable host-capability globals (`require`, `process`,
`fetch`, `setTimeout`, `eval`, and `Function` escapes all resolve to `undefined` inside the isolate).

`db`, `services` and `console` are **synchronous Callbacks** that bridge to the engine main process
over a `SharedArrayBuffer` + `Atomics.wait/notify` channel: the sandbox posts an RPC, the main process
runs the async data-access or provider call, and the sandbox resumes synchronously.

## Limits

- **Memory** — `ivm.Isolate({ memoryLimit })` from `sandbox.memoryLimit`.
- **Timeout** — CPU-bound loops (`while(true)`) are killed by the isolate eval timeout. A dead or
  expired sandbox is destroyed (isolate disposed, worker terminated) and re-spawned on next use, so one
  bad script never poisons later calls.
- **Concurrency** — `maxConcurrentScripts`; over the cap fails fast with `script.busy` (no queueing, so
  nested script calls can't deadlock).
- **Pending async is detected, not silently dropped** — `evalClosure` returns `undefined` as soon as
  synchronous execution yields (isolated-vm drops the settled value of a promise proxy), so hook
  completion is tracked with an in-isolate `__done` sentinel. A hook still pending when `evalClosure`
  returns (e.g. `await new Promise(()=>{})`) is reported as a **timeout** and the sandbox destroyed
  (lazily re-spawned), rather than silently succeeding with `undefined`. Hooks that await the
  (synchronous) `db`/`services` calls resolve deterministically.

## Error semantics

| Where | Behavior |
| --- | --- |
| `validate` / `beforeUpdate` / `beforeDelete` throw | write **aborts** — PG untouched; REST returns `400 script.abort` with the hook message |
| sandbox timeout / crash | write aborts; `script.timeout` (500) |
| `afterUpdate` / `afterDelete` throw | write **already committed**; the message is delivered via `ctx.onWarnings` and **appended as a `warnings` array on the REST response** (`POST`/`PATCH`); `DELETE` (204) has no body, so it's recorded to **audit** only |
| compile error in `server.js` | `script.compile` on first dispatch (500) — the file is loaded lazily |
| `isolated-vm` not installed | `script.sandbox.unavailable` at startup (fail fast) |

## Related

- [Authoring hooks](02-authoring.md)
- [Context API](03-context-api.md)
- [Audit](../../09-platform/03-audit.md) — after-hook failures as `isError` events

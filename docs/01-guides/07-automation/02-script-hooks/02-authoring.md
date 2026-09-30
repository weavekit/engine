---
title: Authoring hooks
description: "The server.js hook list, how they run, and editing the source over the API."
---

# Authoring hooks

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
`onEnter` / `onExit` / `onTimeout`); `beforeTransition` is not dispatched. See
[Workflow → Lifecycle](../../06-workflow/03-lifecycle.md) for the ones that fire.

## `onLoad` — the read hook

Runs when records are loaded, so you can decorate or redact them for the current user. It receives the
whole batch as `this.records`, mutates it (or builds a copy), and **returns an equal-length array** (or
`undefined` to keep the batch unchanged). `this.record` is `null` and `this.changes` is `{}`.

`onLoad` is **transform-only**: membership is already fixed by RLS + filter + pagination, so `total`
stays accurate, and returning a different-length array is an error (`400 script.abort`). It fires for
`find`, `findOne`, and the record returned by `create`/`update`, so `POST`/`PATCH` responses match
`GET`. Re-entrant reads of the same object inside the hook skip `onLoad` (no recursion).

## Examples

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

## Order and scoping

- **Hook order** — the engine runs `RBAC → declarative validation → validate → beforeUpdate → write →
  afterUpdate`. Running validation after RBAC is strictly safer and keeps one decorator-free
  data-access path.
- **`beforeUpdate` writes** — `this.changes` is structured-cloned into the sandbox, so mutating it
  alone does **not** propagate. The hook must **return** the (possibly modified) changes to persist.
- **`db.objects` RBAC** — script calls rebuild the caller's identity as an `IdentitySubject` (id +
  roles). `departmentId` is **not** carried, so department-scoped reads aren't available inside scripts.

## Editing `server.js` over the API

Admin tooling can read and write the hook source through REST:

```
GET {prefix}/objects/:name/scripts/server
PUT {prefix}/objects/:name/scripts/server
```

`GET` returns `{ source, version }`; `PUT` accepts `{ source, expectVersion? }` and returns
`{ ok, committed, version }`.

- **Access** — both require a role in `adapters.rest.adminRoles`; with that list absent they fail closed.
- **Validation** — `PUT` parses the JavaScript without executing it and requires the documented
  parameterless `this`-based signature; invalid source is rejected with `400`.
- **Write** — the source is written atomically to `objects/<name>/server.js` and committed as the only
  path in a Git commit; unrelated staged work stays staged, and a Git failure restores the prior file.
  Missing files may be created, and empty source is valid. `expectVersion` is accepted for forward
  compatibility; the write is still last-write-wins.

Commit behavior: [Git-versioned metadata](../../03-model/04-git-versioned-metadata.md).

## Related

- [Context API](03-context-api.md) — what `this` exposes
- [Sandbox & errors](04-sandbox.md)

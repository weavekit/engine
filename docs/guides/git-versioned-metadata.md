---
description: "Your data model is a Git repository: how WeaveKit versions metadata as reviewable commits, keeps concurrent edits safe, and pairs Git history with the audit log."
---

# Git-versioned metadata

Your project's metadata is **plain files in a Git repository**. The engine treats those files as the
source of truth and PostgreSQL as a derived cache plus your business tables. The sync is one-way:

```
objects/**, policies/**   ──▶   PostgreSQL
   (source of truth)              (metadata cache + business tables)
```

Nothing about your data model is stored only in the database. That buys you the workflow you already
use for code: review a schema change as a diff, open a pull request, `git blame` a field, revert a bad
release, and branch a risky model change before it lands.

## What the engine tracks

Every metadata file is committed under its own path and with a message that says what changed:

| File | Written by | Commit message |
| --- | --- | --- |
| `objects/<name>/schema.json` | `weave` commands, `PUT …/schema` | `chore(schema): update <name>` |
| `objects/<name>/server.js` | `PUT …/scripts/server` (or by hand) | `chore(scripts): update <name>/server.js` |
| `policies/<name>` | `PUT …/guardrails/policies/<name>` | `chore(policies): update <name>` |

`weave migrate` and `weave dev` diff the loaded schema against `git HEAD` and commit the whole
`objects/` tree with a field-level summary — for example:

```
chore(metadata): update schema (2 objects)

lead:
  + priority (enum, default "normal")
  ~ amount required: false → true
company:
  + size (integer)
```

## Every change is committed

You rarely type `git commit` for metadata. Both entry points commit for you:

- **CLI** — `weave object:create`, `field:add`, `module:add`, `module:remove`, `schema:upgrade` and
  `weave types` commit the files they write. `weave introspect --no-commit` opts out.
- **REST** — the admin source endpoints (schema, `server.js`, guardrail policies) write the file and
  commit it in one step.
- **Sync** — `weave migrate` / `weave dev` commit the `objects/` tree after a successful sync.

If the metadata tree is **git-ignored** (a project nested inside a larger repo), the commit is a
no-op rather than an error — the files still change, they just stay yours to commit.

## Safe commits

Metadata writes are built to never leave the tree half-written or sweep up unrelated work:

- **Atomic writes** — content is written to a temp file under `.weavekit/` and renamed into place, so
  a crash never leaves a torn `schema.json`.
- **Scoped commits** — the engine commits only the paths it touched
  (`git commit --only -- <paths>`). Anything else you had staged stays staged.
- **Serialized per project** — source writes are queued per project directory, so two concurrent
  edits cannot interleave into the same commit.
- **Rollback on failure** — if the commit fails, the previous file content (or the file's absence) is
  restored.

## Concurrent edits: `version` and `expectVersion`

Every source read returns a **sha256 content version**, and the schema endpoint lets a writer assert
the version it started from:

```
GET  {prefix}/objects/lead/schema   →  { source, version }
PUT  {prefix}/objects/lead/schema   { source, expectVersion: "<version>" }
```

If the file changed in between, the write fails with **`409 source.versionMismatch`** instead of
silently overwriting the other editor; pass `force: true` to write unconditionally. This is what an
editor or an agent UI should use to avoid clobbering a teammate. Script and policy sources return
`{ source, version }` too, but their writes are currently last-write-wins (`expectVersion` is
accepted and ignored).

## History

Because every change is a commit, history is free. Guardrail policies expose it over the API:

```
GET {prefix}/guardrails/policies/<name>/history
```

The response lists the commits that touched the file (newest first) — sha, author, date, message —
each with the source blob at that commit, so you can render a diff between any two versions. For
anything else in the tree, plain `git log --follow -- objects/lead/schema.json` gives you the same.

## Git and the audit log are different things

They version different layers and you want both:

| | Git | Audit (`weavekit_audit`) |
| --- | --- | --- |
| Versions | **metadata** — schema, hooks, policies | **business data** — row writes |
| Evidence | diffs, authors, messages | immutable events with `before`/`after` row snapshots |
| Lives in | your repository | PostgreSQL |

The two are joined: when a sync applies schema changes, the engine diffs against Git HEAD, commits,
and records a `schema.changed` audit event per object carrying the **`commitSha`**; the last commit's
author becomes the audit actor. So a data write in the audit trail points back to the exact metadata
commit that was live — see [Audit](audit.md) and
[Custom tools, guardrails & audit replay](custom-tools-and-guardrails.md).

## When the project is not a Git repository

Git is strongly recommended but not required:

- `weave dev` prints `warning: not a git repository — schema changes not committed` and keeps running;
  `weave migrate` still syncs to PostgreSQL.
- History endpoints degrade to an empty list instead of failing.
- Commits fall back to a local `weavekit <support@weavekit.io>` identity when Git has none configured.

Failures bubble up with stable codes: `git.notRepo` (the directory is not a work tree) and
`git.command.failed` (a `git` invocation failed).

## Recommended workflow

- **Treat metadata like code.** Author schema changes in a branch, review the diff, merge to `main`.
- **Keep the database derived.** Never hand-edit the metadata cache; change the files and re-sync.
- **Guard CI.** Run `weave migrate --dry-run` (and `weave schema:map --drift`) to catch drift before
  deploy; both are read-only.
- **Deploy from a commit.** Because every change is committed, rolling back metadata is a `git revert`
  away.

## Next

- [Schema guide](schema.md) — the format the files use
- [CLI reference](cli.md) — every `weave` command and its `--no-commit` option
- [Audit](audit.md) — the business-data evidence log

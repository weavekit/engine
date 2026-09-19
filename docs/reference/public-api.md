# Public API & dependency budget

This page defines what `@weave-kit/engine` promises to keep stable — and what it
does not. It is the contract downstream packages (client, UI adapters) and external
integrators code against.

## Entry points — three tiers

| Import | Tier | Promise |
| --- | --- | --- |
| `@weave-kit/engine` | **stable** | app / integration contract; breaking changes only in a major release |
| `@weave-kit/engine/values` | **stable** (browser-safe) | pure `as const` constants (field types, filter ops, …); zero imports |
| `@weave-kit/engine/layout` | **stable** (browser-safe) | page layout format: types + pure functions; runtime import-free |
| `@weave-kit/engine/experimental` | **experimental** | under active development; **may change in a minor release** |
| any other path | **internal** | not importable — blocked by the `exports` map (even `dist/…` deep paths) |

`values` and `layout` are separated subpaths because they must stay free of the
Node server runtime (`pg`/`fastify`/`isolated-vm`) so frontends can bundle them.

The stable entry covers: engine assembly (`createEngine`,
`buildEngineFromRegistry`), core contracts (`core/*`), data access, git
metadata sync, custom tools, the generic proxy, protocol adapters
(auth/rest/mcp/events), audit/script contract types, and the scaffolder
(`scaffoldProject`, `PROJECT_TYPES`).

The experimental entry covers implementations and moving parts that are not yet
worth freezing: `infrastructure/*` provider implementations, the metadata cache,
the tunnel transport, and the ops (health/ready) routes.

> The tier boundary is enforced by `tests/unit/public-api.test.ts` (stable must
> expose the contract names and must **not** leak internals; experimental must
> expose them). When you move a module between tiers, update that test and this
> page in the same change.

## Extension points

The reason a stable surface exists is so people can extend the engine without
hacking internal paths:

- **Auth / identity** — `auth.source` and `mcp.identities` accept resolvers.
- **Providers** — implement the `core/provider/*` contracts (alerts, identity,
  event) and inject them; implementations live outside `core`.
- **Subsystems** — enabled through `weavekit.config.ts` and dynamically loaded.
- **Custom tools & guardrail policies** — `core/tools` + `runtime/tools`.
- **Generic proxy** — `proxy.resolver` carries the application semantics.
- **Protocol adapters** — the `adapters/*` registration functions.

## Dependency budget

A headless engine wins on installing anywhere and starting fast, so the
dependency surface is a product feature, not an accident:

- `core/` — **zero dependencies** (types, pure functions, `as const` values).
- `runtime/` — Node built-ins (`node:*`) only; no third-party runtime imports
  beyond the platform required by the layer.
- A new **runtime** dependency needs a written justification; prefer a Node
  built-in (e.g. the proxy uses the global `fetch` + `AbortSignal.timeout`
  instead of an HTTP client).
- **Native / optional** dependencies (e.g. `isolated-vm`) belong in
  `optionalDependencies` and must degrade with an actionable error when absent —
  users without that feature must not pay for it.
- `./values` and `./layout` must never gain a runtime import (guarded by
  `tests/unit/values-browser-safe.test.ts`).

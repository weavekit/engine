---
description: "Which parts of `@weave-kit/engine` are safe to build on, which are still moving, and how the package enforces the boundary."
---

# Public API & dependency budget

Not every import is a promise. This page tells you which parts of `@weave-kit/engine` are safe to
build on, which are still moving, and how the two are kept apart. It is the contract that downstream
packages (the client SDK) and external integrators code against.

## Entry points — three tiers

| Import | Tier | Promise |
| --- | --- | --- |
| `@weave-kit/engine` | **stable** | app / integration contract; breaking changes only in a major release |
| `@weave-kit/engine/values` | **stable** (browser-safe) | pure `as const` constants (field types, filter ops, …); zero imports |
| `@weave-kit/engine/experimental` | **experimental** | under active development; **may change in a minor release** |
| any other path | **internal** | not importable — blocked by the `exports` map (even `dist/…` deep paths) |

`values` is a separate subpath for one reason: it must stay free of the Node server runtime
(`pg` / `fastify` / `isolated-vm`) so it can be bundled anywhere, including the browser.

The stable entry covers engine assembly (`createEngine`, `buildEngineFromRegistry`), the core
contracts (`core/*`), data access, [Git metadata sync](../guides/git-versioned-metadata.md), custom
tools, the generic proxy, the protocol adapters (auth/rest/mcp/events), the OpenAPI document
generator (`buildOpenApiDocument`), the audit/script contract types, and the scaffolder
(`scaffoldProject`, `PROJECT_TYPES`).

The experimental entry covers the moving parts that aren't worth freezing yet: the
`infrastructure/*` provider implementations, the metadata cache, the tunnel transport, and the ops
(health/ready) routes.

> The tier boundary is enforced by `tests/unit/public-api.test.ts`: the stable entry must expose the
> contract names and must **not** leak internals, while the experimental entry must expose them. When
> you move a module between tiers, update that test and this page in the same change.

## Extension points

The stable surface exists so you can extend the engine without patching internal paths:

- **Auth / identity** — `auth.source` and `mcp.identities` accept resolvers.
- **Providers** — implement the `core/provider/*` contracts (alerts, identity, event) and inject them; implementations live outside `core`.
- **Subsystems** — enabled through `weavekit.config.ts` and dynamically loaded.
- **Custom tools & guardrail policies** — `core/tools` + `runtime/tools`.
- **Custom field types** — `loadFieldTypesDir` / `resolveFieldTypeRegistry` + config `fieldTypes`; a
  project-local `field-types/` dir of declarative registrations (see
  [Custom field types](./custom-field-types.md)).
- **Generic proxy** — `proxy.resolver` carries the application semantics.
- **Protocol adapters** — the `adapters/*` registration functions.

## Dependency budget

A headless engine should install anywhere and start fast, so the dependency surface is a product
feature, not an accident:

- `core/` — **zero dependencies** (types, pure functions, `as const` values).
- `runtime/` — Node built-ins (`node:*`) only; no third-party runtime imports beyond the platform required by the layer.
- A new **runtime** dependency needs a written justification. Prefer a Node built-in, the way the proxy uses the global `fetch` and `AbortSignal.timeout` instead of an HTTP client.
- **Native / optional** dependencies (such as `isolated-vm`) belong in `optionalDependencies` and must degrade with an actionable error when absent — users who don't use a feature shouldn't pay for it.
- `./values` must never gain a runtime import (guarded by `tests/unit/values-browser-safe.test.ts`).

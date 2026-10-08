---
title: "Release checklist"
description: "The maintainer checklist for cutting an @weave-kit/engine release."
---

# Release checklist

Run through this before `npm publish`. The engine is the first package in the
publish order (`engine` → `client` → `create-weavekit-app`); the dependent
packages pin `@weave-kit/engine` to the new version afterwards.

## 1. Version

- [ ] `package.json` `version` **matches** `src/version.ts` (`version`) — a test / the scaffolder assumes they agree.
- [ ] Optional prerelease tag carried through both (semver `X.Y.Z`; pre-1.0 breaking changes are allowed, post-1.0 additively only).

## 2. Changelog

- [ ] `CHANGELOG.md` has a section for the version (Keep a Changelog: Added / Changed / Fixed / Removed), written for consumers.

## 3. Contract version

- [ ] If the change breaks a **frozen** contract (schema/workflow format, REST routes, MCP tool names, event types, error codes, public exports) → bump `CONTRACT_VERSION` (`src/version.ts`).
- [ ] `tests/unit/contract-freeze.test.ts` passes (it pins the frozen values).

## 4. Generated files & docs

- [ ] Regenerate the OpenAPI document and commit it: `npm run openapi:docs` (CI fails on drift).
- [ ] Docs links stay reachable from `docs/README.md`: `npm run lint` (runs the docs-link + memory-size guards).
- [ ] Public README (`README.md`) reflects notable capabilities added since the last release.

## 5. Build & verify

- [ ] `npm run build` produces `dist/` (the published artifact).
- [ ] `npm run typecheck` · `npm run lint` · `npm run test` (unit + PostgreSQL e2e) all green.
- [ ] `npm run test:coverage` meets the security-critical thresholds.
- [ ] `node scripts/check-exports.mjs` — `package.json#exports` targets exist and the contract names are exported.
- [ ] `npm pack` then install the tarball in a scratch project and `import('@weave-kit/engine')` (CI does this).

## 6. Publish

- [ ] `npm publish --access public` (requires the OTP); order `engine` → `client` → `create-weavekit-app`.
- [ ] After engine publishes, poll `npm view @weave-kit/engine version` and bump the dependents' ranges before publishing them.
- [ ] `git tag vX.Y.Z` and push the tag.

## 7. Post-release

- [ ] Sync the docs site from the new tag.
- [ ] Confirm a fresh `create-weavekit-app` scaffold + `weave doctor` + `weave migrate` works against the published version.

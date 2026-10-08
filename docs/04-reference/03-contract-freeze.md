---
title: "Contract freeze (G1)"
description: "What is frozen at 1.0 and how the engine evolves after it."
---

# Contract freeze (G1)

From **1.0** the engine's public contract is frozen under a single
`CONTRACT_VERSION` (exported from `@weave-kit/engine`, also returned by `GET /version`
as `contractVersion` and embedded in the OpenAPI document as `info.x-contract-version`).

## What is frozen

| Surface | Frozen at |
| --- | --- |
| `schema.json` on-disk format | `SCHEMA_FORMAT_VERSION` (`6`) |
| `workflow.json` on-disk format | `WORKFLOW_FORMAT_VERSION` (`2`) |
| Pagination cursors | `CURSOR_VERSION` (`1`) |
| REST routes | the `adapters/rest` route set |
| MCP tool names | `search_records` / `get_record` / `create_record` / `update_record` / `delete_record` + `list_objects` / `describe_object` + `workflow_transition` |
| Event types | `record.created` / `updated` / `deleted` / `transitioned`, `audit.event`, `schema.changed`, `schema.drift`, `lifecycle.shutdown` |
| Error codes | the `SchemaError` message keys (`code`), mapped to HTTP status by `mapSchemaError` |
| data-access / RBAC contracts | `ObjectDataAccess`, `DataAccessContext`, `resolvePermission` / `buildRowScope` |
| Package exports | the `.` entry point (types re-exported from the package root) |

A test (`tests/unit/contract-freeze.test.ts`) pins the single-source values above, so any change to
them fails the build until it is a deliberate, version-bumping change.

## How the engine evolves after 1.0

- **Additive by default.** New fields, routes, tools, error codes, options and exports are allowed in
  a minor/patch release and do **not** bump `CONTRACT_VERSION`.
- **Deprecation.** A surface to be removed is first marked deprecated and kept for **at least one
  minor release**; removal happens only at a **major** release and bumps `CONTRACT_VERSION`.
- **Experimental.** Unstable surfaces live under the `@weave-kit/engine/experimental` subpath and are
  **not** covered by the freeze; they may change in any release.
- **Formats self-migrate.** `schema.json` / `workflow.json` older versions are migrated on read
  (`weave schema:upgrade` / `weave workflow:upgrade` stamp the current version), so a format bump is
  additive in practice.

## Extension seams (never frozen shut)

Enterprise/custom extensions build on stable seams that keep evolving **additively**:
`AuthVerifier` / `IdentitySource`, `ApprovalsBackend`, guardrails policies, `AuditSink` /
`AuditQueryEngine`, `EventPublisher`, `EvidenceSink`, `WorkflowBackend` / `WorkflowTimerStore` /
`WorkflowCoordinator`, `CounterStore`. New methods may be added; existing signatures are not broken.

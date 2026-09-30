---
title: service
description: "The service preset: a headless backend with RBAC and script hooks."
---

# service

```
create-weavekit-app my-app --type=service
```

Narrative: *Business service — headless backend with RBAC and a REST API.*

## What it scaffolds

- **Script subsystem on** (`subsystems.script: { enabled: true }`) — `*.server.js` hooks run in the
  sandbox.
- `features.fieldTypes` includes the opt-in types.
- REST + MCP enabled (as always).

## What it's for

A headless backend that other teams or services consume: RBAC-scoped objects over REST, with
server-side hooks for the logic you don't want clients to own. Think "internal API for a business
domain", not a product UI.

## What you'll usually add

- **Script hooks** for validation and side effects (`objects/<name>/server.js`).
- **Quotas** if different callers share the API.
- **Events / ingress** to talk to other systems.

## Read next

- [RBAC](../04-access/02-rbac.md)
- [Script subsystem](../07-automation/02-script-hooks/01-overview.md) — sandboxed lifecycle hooks
- [Live events (SSE)](../08-integration/02-events.md)
- [Quotas](../07-automation/03-quotas.md)

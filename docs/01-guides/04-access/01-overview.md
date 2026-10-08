---
title: Access
description: "Who can do what: RBAC roles, row scopes, field exclusions, and where identities come from."
---

# Access

The engine decides access from the **subject** on each request — you bring the identity, RBAC decides
the rest. These two pages cover the two halves.

- [RBAC](02-rbac.md) — roles, permissions, row scopes and field-level exclusions
- [Identity](03-identity.md) — the engine identity directory and syncing from an external source
- [Multi-tenancy (row)](04-multi-tenancy.md) — scope every read/write to a subject's tenant

---
title: governance
description: "The governance preset: auditable, permission-scoped business objects."
---

# governance

```
create-weavekit-app my-app --type=governance
```

Narrative: *Governance platform — auditable, permission-scoped business objects.*

## What it scaffolds

- No script subsystem — hooks are off.
- `features.fieldTypes` includes the opt-in types (relations, currency, enums), so the full schema
  surface is available up front.
- REST + MCP enabled (as always).

## What it's for

You're standing up a system of record where **who can see and change what** matters as much as the
data itself: row scopes by owner/department, field-level exclusions, and an audit trail you can
replay. Governance leans on RBAC, identity and audit rather than on custom code.

## What you'll usually add

- **Audit** — usually already on, but make sure `subsystems.audit` is enabled if you trimmed it.
- **Identity** sync if users come from an external directory.
- **Workflow** when records need an approval chain before they take effect.

## Read next

- [RBAC](../04-access/02-rbac.md) — roles, permissions, row scopes
- [Identity](../04-access/03-identity.md) — the identity directory and source sync
- [Audit](../09-platform/03-audit.md) — the immutable event log
- [Workflow](../06-workflow/01-overview.md) — governed lifecycles
- Practice: [plug in the customer's user store](../../03-practices/02-governance/02-bring-your-own-user-store.md)

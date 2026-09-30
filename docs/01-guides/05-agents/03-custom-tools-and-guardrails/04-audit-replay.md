---
title: Audit replay
description: "Record before/after row snapshots on writes so you can reconstruct exactly what changed."
---

# Audit replay

Audit events already record who did what (`weavekit_audit` — tool-call evidence like `mcp.tool.<name>`,
plus data-access write events). Snapshots are recorded at the **data-access write path**, so every
write interface — REST, script hooks, MCP tools, and host calls — gets the same evidence. With
`replay` on, the engine additionally snapshots the **actual row before and after**, so you can
reconstruct exactly what changed:

```ts
// weavekit.config.ts
export default {
  subsystems: {
    audit: {
      enabled: true,
      replay: true,     // record before/after row snapshots on update/delete
    },
  },
};
```

- `update` events carry `before` (old row) and `after` (merged row).
- `delete` events carry `before`.
- `create` needs no snapshot — `changes` is already the full inserted row.
- Snapshots reuse the row the transaction already read, so there are **zero extra queries**.

The `weavekit_audit` table always has the `before` / `after` JSONB columns (idempotent), so toggling
`replay` needs **no migration** — it only decides whether the columns are filled. It's off by default
to avoid storage growth; retention is a product-layer concern.

## Related

- [Audit](../../09-platform/03-audit.md) — the immutable event log and diff replay
- [Custom tools](02-custom-tools.md)
- [Guardrail policies](03-guardrails.md)

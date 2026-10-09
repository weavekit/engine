---
title: business
description: "The business preset: objects and computed formulas on Postgres."
---

# business

```
create-weavekit-app my-app --type=business
```

Narrative: *Business backend — objects and formulas on Postgres.*

## What it scaffolds

- **Script subsystem on**, same as `service`.
- `features.fieldTypes` includes the opt-in types — formulas need the scalar types they compute.

> Heads up: `business` scaffolds the **headless engine only** (REST/MCP/RBAC/audit/script) — no UI.
> The former business-UI groundwork (`objects/<name>/*.client.js`, `pages/<name>/layout.json`) was
> **retired** and is no longer emitted.

## What it's for

Object models with derived values: totals, labels, flags computed from other fields, stored on write.
See [Formulas](../03-model/03-formulas.md) for the operators, functions, aggregations and null rules.

## Read next

- [Schema guide](../03-model/02-schema/01-overview.md)
- [Formulas](../03-model/03-formulas.md)
- [Script subsystem](../07-automation/02-script-hooks/01-overview.md)

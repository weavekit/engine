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
- **Business UI groundwork**: the scaffolder also emits `objects/<name>/*.client.js` and
  `pages/<name>/layout.json`.

> Heads up: those UI files are **experimental groundwork**. There's no in-project renderer yet — the
> engine is headless and renders no DOM. Treat `business` as a normal headless backend for now; the
> extra files are there for when a product line lands on top.

## What it's for

Object models with derived values: totals, labels, flags computed from other fields, stored on write.
See [Formulas](../03-model/03-formulas.md) for the operators, functions, aggregations and null rules.

## Read next

- [Schema guide](../03-model/02-schema/01-overview.md)
- [Formulas](../03-model/03-formulas.md)
- [Script subsystem](../07-automation/02-script-hooks/01-overview.md)

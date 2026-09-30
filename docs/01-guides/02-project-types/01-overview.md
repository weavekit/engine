---
title: Project types
description: "The four starting presets — agent, governance, service, business — and what each one scaffolds."
---

# Project types

A project type is just a **starting preset**. It picks a narrative and two defaults:

- the initial field-type whitelist (`features.fieldTypes`),
- whether the script sandbox is on (`subsystems.script`).

That's it. It never trims core: every type gets the same engine, REST, MCP and RBAC. You can
`weave module:add` later (audit, script, workflow) or edit `weavekit.config.ts` by hand. The type is
written to `projectType` in config, mostly so the scaffolder and tooling know the intent.

| Type | For | Script | Field types |
| --- | --- | --- | --- |
| [agent](02-agent.md) | AI-agent backend | off | primitives only |
| [governance](03-governance.md) | auditable, permission-scoped objects | off | primitives + opt-in |
| [service](04-service.md) | headless backend with RBAC | on | primitives + opt-in |
| [business](05-business.md) | objects + formulas | on | primitives + opt-in |

Pick one with `create-weavekit-app my-app --type=agent` (default is `agent`).

- [agent](02-agent.md) — objects + REST for agents
- [governance](03-governance.md) — audit and row/field scoping
- [service](04-service.md) — RBAC plus script hooks
- [business](05-business.md) — formulas on Postgres

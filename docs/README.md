---
description: "Documentation for `@weave-kit/engine` — let AI agents operate your data, safely."
---

# Overview

**Let AI agents operate your data — safely.**

The pitch and quick start live in the [repository README](../README.md).

## Start here

- [Getting started](01-guides/01-getting-started.md) — scaffold, migrate, run, call the API
- [Connect an agent](03-practices/01-agent/04-connect-agent.md) — a local first run in five minutes
- Scaffolding a preset? `--type=agent|governance|service|business` → [Project types](01-guides/02-project-types/01-overview.md)

## By goal

- **Put an agent on an existing database** → [Existing CRM → MCP](03-practices/01-agent/02-existing-crm-to-mcp.md)
- **Model your data** → [Schema](01-guides/03-model/02-schema/01-overview.md) · [Named enums](01-guides/03-model/02-schema/06-named-enums.md) · [Formulas](01-guides/03-model/03-formulas.md)
- **Lock it down** → [RBAC](01-guides/04-access/02-rbac.md) · [Identity](01-guides/04-access/03-identity.md) · [Audit](01-guides/09-platform/03-audit.md)
- **Govern a lifecycle** → [Workflow](01-guides/06-workflow/01-overview.md) — role gates, approvals, timeouts
- **Run it in production** → [Deployment](02-operations/01-deployment/01-overview.md)

## Guides

- [Project types](01-guides/02-project-types/01-overview.md) — the four presets and what each scaffolds
- [Model](01-guides/03-model/01-overview.md) — schema, formulas, git-versioned metadata
- [Access](01-guides/04-access/01-overview.md) — RBAC and identity
- [Agents](01-guides/05-agents/01-overview.md) — MCP, custom tools & guardrails, approvals
- [Workflow](01-guides/06-workflow/01-overview.md) — per-object approval chains
- [Automation](01-guides/07-automation/01-overview.md) — script hooks and quotas
- [Integration](01-guides/08-integration/01-overview.md) — live events, inbound events, proxy, tunnel
- [Platform](01-guides/09-platform/01-overview.md) — CLI, audit, i18n

## Operations

- [Deployment](02-operations/01-deployment/01-overview.md) — containerize, reverse-proxy, TLS

## Practices

- [Agent](03-practices/01-agent/01-overview.md) — wiring an existing database into an agent surface
- [Governance](03-practices/02-governance/01-overview.md) — customer user stores, governed lifecycles
- [Service](03-practices/03-service/01-overview.md) — service-shaped backends
- [Business](03-practices/04-business/01-overview.md) — object/formula backends
- [Modeling](03-practices/05-modeling/01-overview.md) — shared vocabularies and reusable definitions

## Reference

- [API](04-reference/01-api/01-overview.md) — public API tiers and the dependency budget
- [Schema](04-reference/02-schema/01-overview.md) — custom field types

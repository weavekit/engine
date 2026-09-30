---
title: agent
description: "The agent preset: metadata-driven objects with REST and MCP access for AI agents."
---

# agent

```
create-weavekit-app my-app --type=agent
```

Narrative: *AI-Agent backend — metadata-driven objects with REST access for AI agents.*

## What it scaffolds

- No script subsystem — hooks are off.
- `features.fieldTypes` limited to the primitives. Opt-in types (relations, currency, enums, custom
  types) are gated off until you widen the whitelist.
- REST (`/api`) and MCP (`/mcp`) enabled, same as every type.

## What you'll usually add

- **MCP identities** for the users agents act on behalf of (`adapters.mcp.identities`). RBAC decides
  each identity's tool surface, so set this up before exposing anything.
- **Guardrails** once agents can write: rate limits, and `requireApproval` for risky calls.
- More **field types** in `features.fieldTypes` when the domain needs them.

## Read next

- [MCP](../05-agents/02-mcp/01-overview.md) — expose objects as tools, per identity
- [Custom tools, guardrails & audit replay](../05-agents/03-custom-tools-and-guardrails/01-overview.md)
- [Approvals](../05-agents/04-approvals.md) — human-in-the-loop for tool calls
- Practices: [integrate an existing CRM](../../03-practices/01-agent/02-existing-crm-to-mcp.md),
  [design an agent-friendly schema](../../03-practices/01-agent/06-agent-friendly-schema.md)

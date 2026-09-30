---
title: Guardrails
description: "Rate limiting, alerts and the audit trail for MCP tool calls."
---

# Guardrails

The MCP adapter wraps every tool call with rate limiting, alerting and audit. The point is that an
agent can't quietly hammer your data or slip past RBAC.

- **Rate limiting** — a per-agent-key sliding window (default 100 / 60s). Over-limit calls return an
  `isError` result and fire a `warn` alert.
- **Alerts** — an injected `AlertSink` (default console; webhook/slack via config under
  `adapters.mcp.guardrails.alerts`).
- **Audit** — every tool attempt writes `mcp.tool.<name>` to the unified `weavekit_audit` table (action
  prefix `ACTION_PREFIXES.MCP_TOOL`), including RBAC denials and failures. `actorId` is the agent key;
  `meta` carries `{ onBehalfOf, subjectId, roles, agentLabel, tool }`. Audit is best-effort — a failing
  sink never blocks the tool call.
- **Impersonation** — a call-level `onBehalfOf` tool argument is **disabled by default**
  (`mcp.impersonation` defaults to `off`); set it to `'directory'` to let an agent switch to any
  identity in the configured directory per call. See [Identities](03-identities.md).

For the policy pipeline behind these (custom tools, `requireApproval`, replay), see
[Custom tools & guardrails](../03-custom-tools-and-guardrails/01-overview.md). For the durable trail,
see [Audit](../../09-platform/03-audit.md).

## Related

- [MCP overview](01-overview.md)
- [Identities](03-identities.md)
- [Audit](../../09-platform/03-audit.md)

---
description: "Guides, operations, practices and reference for `@weave-kit/engine` — and where to start if you're new."
---

# Overview

Topic-focused documentation for `@weave-kit/engine`. New to the engine? Read
[Getting started](guides/getting-started.md) first, then [MCP](guides/mcp.md) to put an agent on your
data. Your data model is versioned in Git — see
[Git-versioned metadata](guides/git-versioned-metadata.md). The project pitch and quick start live in
the [repository README](../README.md).

## Guides

- [Getting started](guides/getting-started.md) — scaffold, migrate, run, and consume the API
- [Git-versioned metadata](guides/git-versioned-metadata.md) — your data model as reviewable Git commits
- [Schema guide](guides/schema.md) — fields, relations, computed fields and validation
- [RBAC](guides/rbac.md) — roles, permissions and row scopes
- [Formulas](guides/formulas.md) — operators, functions, aggregations and null semantics
- [Audit](guides/audit.md) — the immutable event log and diff replay
- [CLI reference](guides/cli.md) — every `weave` command
- [MCP](guides/mcp.md) — expose objects as agent tools, per identity
- [Script subsystem](guides/script-hooks.md) — sandboxed `*.server.js` lifecycle hooks
- [Custom tools, guardrails & audit replay](guides/custom-tools-and-guardrails.md) — the open contract
- [Quotas](guides/quotas.md) — usage budgets consumed by tools and scripts
- [Inbound events](guides/ingress.md) — signed webhooks mapped to engine actions
- [Live events (SSE)](guides/events.md) — push data and metadata changes to clients
- [Generic proxy](guides/proxy.md) — a path-allowlisted gateway to other instances
- [Tunnel transport](guides/tunnel.md) — reach a NAT'd engine over an outbound HTTP/2 tunnel
- [Approvals](guides/approvals.md) — the human-in-the-loop queue
- [Workflow](guides/workflow.md) — declarative per-object state machines
- [Workflow tutorial](guides/workflow-tutorial.md) — end-to-end: enable, transition, approvals, timeouts, evolution
- [Localization (i18n)](guides/i18n.md) — message catalogs and stable error codes

## Operations

- [Deploying with Docker](operations/docker-deploy.md) — containerize the engine + PostgreSQL
- [Reverse proxy + TLS](operations/reverse-proxy.md) — Caddy / Nginx and streaming caveats

## Practices

- [Integrating an existing CRM with MCP](practices/existing-crm-to-mcp.md) — start from live tables
- [Exposing a large schema to an agent](practices/large-schema-agent-surface.md) — a fixed tool surface for many objects
- [Designing an agent-friendly schema](practices/agent-friendly-schema.md) — labels, types and permissions an agent can trust
- [Plugging in the customer's own user store](practices/bring-your-own-user-store.md) — resolver-driven identity
- [Connecting MCP hosts](practices/connecting-mcp-hosts.md) — Claude Desktop, Cursor, gateways
- [Connect an agent](practices/connect-agent.md) — local first run in five minutes

## Reference

- [Public API & dependency budget](reference/public-api.md) — entry-point tiers and extension points
- [Custom field types](reference/custom-field-types.md) — register business-semantic field types

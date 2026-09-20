# Overview

Topic-focused documentation for `@weave-kit/engine`. New to the engine? Read
[Getting started](guides/getting-started.md) first, then [MCP](guides/mcp.md) to put an agent on your
data. The project pitch and quick start live in the [repository README](../README.md).

## Guides

- [Getting started](guides/getting-started.md) — scaffold, migrate, run, and consume the API
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

## Operations

- [Deploying with Docker](operations/docker-deploy.md) — containerize the engine + PostgreSQL
- [Reverse proxy + TLS](operations/reverse-proxy.md) — Caddy / Nginx and streaming caveats

## Practices

- [Integrating an existing CRM with MCP](practices/existing-crm-to-mcp.md) — start from live tables
- [Plugging in the customer's own user store](practices/bring-your-own-user-store.md) — resolver-driven identity
- [Connecting MCP hosts](practices/connecting-mcp-hosts.md) — Claude Desktop, Cursor, gateways
- [Connect an agent](practices/connect-agent.md) — local first run in five minutes

## Reference

- [Public API & dependency budget](reference/public-api.md) — entry-point tiers and extension points

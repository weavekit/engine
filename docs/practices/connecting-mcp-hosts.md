# Connecting MCP hosts

Once the engine is running (see [docker](../operations/docker-deploy.md) / [reverse proxy](../operations/reverse-proxy.md)), any MCP client can reach it. The endpoint is a **streamable HTTP** server at `https://<host>/mcp`, and every session needs two headers. How you supply them depends on the host.

> Connecting a **local dev engine** (`weave dev`, `http://localhost:3000/mcp`) for the first time? Start with [connect an agent](connect-agent.md) — a 5-minute, copy-paste walkthrough. This page focuses on deployed/HTTPS hosts.

## Background

The engine is deployed and the `/mcp` endpoint answers — but an endpoint is not an agent. The final step is wiring up the actual clients: Claude Desktop on a teammate's laptop, Cursor inside an IDE, a custom agent, or a corporate gateway. Each host configures an MCP server differently, and a misconfigured header is the usual reason "it works from curl but not from my client".

This practice walks each common host through the same two headers, so you can copy the exact config and go.

## Benefits

- **One deployment, every client** — a single `/mcp` endpoint serves Claude Desktop, Cursor, your SDK programs and a gateway; only the config differs.
- **One agent key, many users** — a single `Authorization` key can open many sessions, each bound to a different on-behalf-of identity. No per-user keys to hand out.
- **Per-user tool surfaces without extra setup** — give each human their own on-behalf-of ref; the engine's RBAC filters the tools automatically.
- **Gateway-friendly** — the enterprise pattern keeps the engine's credential on the gateway and injects the acting user per request, so end clients never hold a shared secret.

## When to use this

Relevant in every deployment that is not purely internal-SDK:

- **Claude Desktop / Cursor** — needed as soon as human teammates want the tools in their daily interface.
- **Custom agent** — when you drive the engine from your own program (automation, internal tools).
- **Enterprise gateway** — when the customer routes agents through a central AI gateway that manages credentials and identity centrally.

If you only ever connect from your own code, section 1 (SDK client) is all you need.

## The two required headers

| Header | Value | Effect |
| --- | --- | --- |
| `Authorization` | `Bearer <apiKey>` | agent-level auth (matches `auth.source`) — 401 if missing/bad |
| `X-Weavekit-On-Behalf-Of` | `<ref>` | which identity the session acts as (matches `mcp.identities`) — 400 if unknown |

Both the *agent* (which API key) and the *user* (which CRM user) are decided at session establishment and locked for the session's life.

## 1. SDK client (any custom agent)

The most flexible path — a TypeScript/Node program that connects and calls tools directly:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://agent.example.com/mcp'), {
  requestInit: {
    headers: {
      authorization: 'Bearer sk-agent-claude',
      'x-weavekit-on-behalf-of': 'alice',
    },
  },
});
const client = new Client({ name: 'crm-agent', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();                 // tool surface for alice
const res = await client.callTool({ name: 'search_lead', arguments: { filter: { status: 'active' } } });
console.log(res.content);
```

This is the standard way to drive the engine from your own agent program.

## 2. Claude Desktop

Claude Desktop runs a local MCP config file. Edit it (path varies by OS; on macOS it is `~/Library/Application Support/Claude/claude_desktop_config.json`), add a **remote** (URL-based) server entry with the two headers:

```json
{
  "mcpServers": {
    "crm": {
      "type": "http",
      "url": "https://agent.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sk-agent-claude",
        "X-Weavekit-On-Behalf-Of": "alice"
      }
    }
  }
}
```

Restart Claude Desktop; the `crm` server's tools (e.g. `search_lead`, `get_customer`) then appear in the tools list. Every conversation that uses them runs against **alice** — create a separate server entry (different `X-Weavekit-On-Behalf-Of`) per user you want to switch between.

> Claude Desktop's support for remote `type: "http"` servers arrived in recent releases. If your build predates it, the alternative is a tiny local relay: a script that starts an SDK client (section 1) and exposes it over stdio — Claude connects to that command instead of a URL.

## 3. Cursor

Cursor reads project-local MCP servers from `.cursor/mcp.json` in the repo root (or user/global settings). It supports HTTP servers with headers:

```json
{
  "mcpServers": {
    "crm": {
      "type": "http",
      "url": "https://agent.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sk-agent-cursor",
        "X-Weavekit-On-Behalf-Of": "emma"
      }
    }
  }
}
```

Add the entry, restart Cursor (or toggle the server in the MCP panel), and the tools become available to the agent inline.

## 4. Enterprise gateway / proxy

If the customer routes agents through an internal gateway (e.g. an AI gateway that manages keys centrally), have the gateway do the **agent** auth and inject the *identity* header per request:

- The gateway holds the engine `Authorization` key (agent credential) — it is never exposed to end clients.
- `X-Weavekit-On-Behalf-Of` is set by the gateway from the caller's identity (SSO subject → CRM user ref). This keeps the static directory / resolver as the only place that maps a ref to RBAC roles.

A reverse proxy or gateway **must not** strip or rewrite the two headers — see the [reverse proxy practice](../operations/reverse-proxy.md) for the buffering/streaming caveats that matter here.

## 5. Verifying a connection

From the command line, an `initialize` handshake is easy to check:

```sh
curl -s -X POST https://agent.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer sk-agent-claude' \
  -H 'x-weavekit-on-behalf-of: alice' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Expect a `201`/`200` with a `Mcp-Session-Id` response header and an `initialize` result in the body — that is the handshake that precedes `tools/list`.

## Notes

- **Session scoping is sticky**: whichever `X-Weavekit-On-Behalf-Of` the session was created with stays for its whole life (TTL 30 min idle). Tools never see a different user unless the caller passes a per-call `onBehalfOf` argument (RBAC still re-checks it).
- **One agent key ≠ one user**: a single `Authorization` key can open many sessions, each bound to a different on-behalf-of identity — that is how one agent serves many CRM users without exposing per-user keys.
- To expose different tool sets per human, give each human their own server entry / `onBehalfOf` ref — the engine's RBAC does the filtering.

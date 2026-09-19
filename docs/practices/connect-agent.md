# Connect an agent (5 minutes, local)

So you ran `weave dev` and it printed a **MCP URL**. This page takes you from that URL to a working agent in a local client — Claude Code, Cursor, VS Code, Claude Desktop, or any MCP host — using the engine on `http://localhost:3000`.

This is the **first-run / local** path. For hosts talking to a deployed engine over HTTPS (teammates' laptops, corporate gateways), see the [MCP host setup practice](connecting-mcp-hosts.md).

## Prerequisites

- The engine running locally: `weave dev` (defaults to `http://localhost:3000`, MCP at `/mcp`).
- Two values, both printed by:

  ```sh
  weave mcp:config
  ```

  - **API key** — the agent credential (`Authorization: Bearer …`). The scaffolded project ships a static `auth.source` with `sk-admin`; `weave mcp:config` picks the **first static key** automatically.
  - **on-behalf-of ref** — which identity the session acts as (`X-Weavekit-On-Behalf-Of`). Must be a key of `adapters.mcp.identities` in `weavekit.config.ts`, or the session is rejected with `400`.

Add at least one identity if your config has none, then restart `weave dev`:

```ts
// weavekit.config.ts
adapters: {
  mcp: {
    identities: {
      alice: { id: 'u-alice', roles: ['sales'] },   // roles must match schema.json permissions
    },
  },
},
```

## The two required headers

| Header | Value | Effect |
| --- | --- | --- |
| `Authorization` | `Bearer <apiKey>` | agent auth (matches `auth.source`) — 401 if missing/bad |
| `X-Weavekit-On-Behalf-Of` | `<ref>` | the identity the session acts as (matches `mcp.identities`) — 400 if unknown |

`tools/list` then returns a **per-identity, permission-filtered** tool surface. See [MCP](../guides/mcp.md) for the full contract.

`weave mcp:config` prints the exact snippets below, filled with your project's URL, key and identity. Run `weave mcp:config --host <host>` for one host, or `--json` for machine-readable output.

## 1. Claude Code

```sh
claude mcp add --transport http weavekit http://localhost:3000/mcp \
  --header "Authorization: Bearer sk-admin" \
  --header "X-Weavekit-On-Behalf-Of: alice"
```

Check it loaded: `claude mcp list` (look for `✔ Connected`). Inside a session, `/mcp` shows the server and its tool count.

## 2. Cursor

Create `.cursor/mcp.json` (project) or add to the user config:

```json
{
  "mcpServers": {
    "weavekit": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer sk-admin",
        "X-Weavekit-On-Behalf-Of": "alice"
      }
    }
  }
}
```

Reload Cursor (or toggle the server in the MCP panel); the tools become available inline.

## 3. VS Code

`.vscode/mcp.json` — note the top-level key is **`servers`** (not `mcpServers`):

```json
{
  "servers": {
    "weavekit": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer sk-admin",
        "X-Weavekit-On-Behalf-Of": "alice"
      }
    }
  }
}
```

VS Code asks you to trust the server the first time; then the tools appear in chat.

## 4. Claude Desktop

`claude_desktop_config.json` (path varies by OS; macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "weavekit": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer sk-admin",
        "X-Weavekit-On-Behalf-Of": "alice"
      }
    }
  }
}
```

Restart Claude Desktop. On a build without remote HTTP support, use the stdio bridge below instead.

## 5. stdio-only hosts (bridge)

Hosts that only speak stdio connect through a small local relay (`mcp-remote`) that forwards to the HTTP endpoint:

```sh
npx -y mcp-remote http://localhost:3000/mcp \
  --header "Authorization: Bearer sk-admin" \
  --header "X-Weavekit-On-Behalf-Of: alice"
```

Configure the host with `command: "npx"` and the arguments above.

## 6. Your own agent (SDK)

Any MCP client library works — `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` with the same two headers. See the [SDK example](connecting-mcp-hosts.md#1-sdk-client-any-custom-agent).

## Verify

- **In the client**: the tool list should show `list_objects`, `describe_object`, and `search_/get_/create_/update_/delete_<object>` tools — filtered by the identity's RBAC.
- **From the shell**: run the `curl` snippet from `weave mcp:config --host curl` (or [verifying a connection](connecting-mcp-hosts.md#5-verifying-a-connection)). A `200`/`201` with an `Mcp-Session-Id` response header is a successful handshake.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401` | missing/wrong `Authorization` | use a key present in `auth.source` |
| `400` on connect | unknown on-behalf-of ref | add the ref to `adapters.mcp.identities` |
| server connects but **no tools** | identity's roles match nothing in `schema.json` permissions | align `roles` with the object's `permissions` keys |
| works from curl, not from the client | a proxy stripped/rewrote the two headers | see the [reverse proxy practice](../operations/reverse-proxy.md) |
| `/mcp` not found | MCP disabled or mounted elsewhere | check `adapters.mcp` (`enabled`, `endpoint`) |

## Security

- `sk-admin` is the **scaffold placeholder** — replace it with real keys before anything leaves your machine.
- Give each human their own `on-behalf-of` ref; one agent key can open many sessions, each bound to a different identity (they never share a tool surface).
- The dev endpoint binds `0.0.0.0` by default; for a shared host, front it with TLS and a proxy ([Docker](../operations/docker-deploy.md) / [reverse proxy](../operations/reverse-proxy.md)).

## Next

- [MCP host setup](connecting-mcp-hosts.md) — deployed/HTTPS hosts, enterprise gateway.
- [MCP](../guides/mcp.md) — tool surface, guardrails, identities, resolvers.
- [Custom tools & guardrails](../guides/custom-tools-and-guardrails.md) — custom tools + guardrail policies.

# Reverse proxy + TLS

The engine speaks plain HTTP on an internal port. In front of it you put a TLS-terminating proxy so
public agents can reach `https://agent.example.com/mcp`.

The proxy has one job: **forward every request verbatim**. Three things must survive end to end:

| What must survive the proxy | Why |
| --- | --- |
| `Authorization: Bearer <key>` | authenticates the agent (401 otherwise) |
| `X-Weavekit-On-Behalf-Of: <ref>` | binds the session to a proxied user (400 if missing) |
| `Mcp-Session-Id` (response header + subsequent requests) | streamable-HTTP sessions are stateful |

The engine returns `Mcp-Session-Id` on the `initialize` response, and clients echo it back on later
requests. Both directions must pass through untouched.

## Background

In production, agents connect from outside your network, and "outside" means HTTPS — clients,
browsers, and corporate policy block or flag a plain `http://` endpoint. TLS is usually handled by a
reverse proxy rather than by the engine itself: one certificate fronting the whole deployment, one
place to add access rules.

## Benefits

- **TLS without touching the engine** — terminate HTTPS in the proxy; the engine keeps serving plain HTTP behind the network edge.
- **Automatic certificate management** — Caddy obtains and renews certificates for you; no certbot chores.
- **A single security chokepoint** — the proxy is where you enforce "only `/mcp` (and optionally `/api`) is reachable", plus logging and future gatekeeping.
- **The place to add stickiness later** — when you scale to multiple engine replicas, the proxy or load balancer is where you configure session stickiness by `Mcp-Session-Id`.

## When to use this

Use a reverse proxy when:

- Agents reach the engine over the **public internet** (Claude Desktop, Cursor, external gateways).
- You already run a reverse proxy or load balancer and want the engine behind it like any other service.
- You want one consistent HTTPS boundary across multiple services.

For purely internal deployments (agents on the same private network, engine not exposed outward), the
engine can run on plain HTTP with no proxy. This practice is optional.

## Caddy (simplest — automatic HTTPS)

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

That is the whole file. Caddy obtains and renews the certificate, terminates TLS, and forwards the
connection; headers and streaming (SSE) pass through by default. Start it with `caddy run`; Caddy
watches the file and reloads on change.

## Nginx

`nginx.conf` (server block):

```nginx
server {
    listen 443 ssl;
    server_name agent.example.com;

    ssl_certificate     /etc/letsencrypt/live/agent.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agent.example.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:3000;

        # pass the agent/identity headers untouched
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # streamable HTTP uses SSE responses — do not buffer
        proxy_buffering off;
        proxy_cache off;

        # keep long-lived agent connections open
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # any other engine routes you expose (e.g. /api) go under their own location
}
```

The critical lines are `proxy_buffering off` (SSE must stream, never be buffered) and the long
timeouts (an agent session can idle for a while). If you enable `proxy_buffering`, tools that respond
via `text/event-stream` stall.

## Only proxy what you need

Expose only `/mcp` (and `/api` if your agents use the REST SDK). There is no admin surface, so you
typically need nothing else — keep the default policy to deny and open routes explicitly.

## Streaming caveat

- If tools hang in the agent UI, the first suspect is proxy buffering. Verify `proxy_buffering off` (Nginx), or that your Caddy setup didn't add response buffering.
- Once you run more than one engine replica, load balancers must use **sticky connections** by `Mcp-Session-Id` (or at least by client) — sessions are in-memory per process. A single-replica deployment needs no stickiness.

## Next

- [Docker deployment](docker-deploy.md) — what the proxy fronts
- [MCP host setup](../practices/connecting-mcp-hosts.md) — point Claude Desktop / Cursor / your gateway at the public URL

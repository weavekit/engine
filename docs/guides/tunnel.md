# Tunnel transport

A self-hosted or on-prem engine often has **no routable URL** (behind NAT, on a private network). The
tunnel lets a governance side reach it anyway: the customer engine dials **out** to a tunnel endpoint
over a persistent HTTP/2 `CONNECT` stream, and requests are multiplexed over that one connection. No
inbound port is opened on the customer side, and the customer's local engine is left untouched.

```
governance                         customer
┌──────────────┐   HTTP/2 CONNECT   ┌────────────────────┐
│ tunnel server│◀────────  outbound │  weave connect     │
│  (registry)  │                    │  (connector agent) │──▶ localhost:3000 (engine)
└──────────────┘   request frames ▶ │                    │
        ▲                           └────────────────────┘
        │ transport: 'tunnel'
   proxy forwarder
```

## Customer side

Run the connector beside the engine ([CLI reference](cli.md)):

```sh
weave connect \
  --endpoint https://governance.example.com \
  --tunnel conn_abc --token <pairing-token> \
  --engine http://localhost:3000 --api-key <local-engine-key>
```

It dials out and stays up until `Ctrl+C`. The connector only ever reaches the engine on
`localhost`; it uses `--api-key` for that local call, and forwards nothing except the requests the
governance side sends.

## Governance side

The tunnel is a stable, exported primitive; the governance app composes it:

- **`createTunnelServer({ registry, authenticate })`** — a `node:http2` server that accepts the
  connector's `CONNECT`, authenticates `(tunnel_id, pairing_token)` (headers `x-weavekit-tunnel` +
  `Authorization: Bearer`), and registers the live session in the `TunnelRegistry` by `tunnel_id`.
  It accepts h2c (prior-knowledge) or TLS.
- **`TunnelRegistry`** — maps `tunnel_id` → live session; `request()` / `openStream()` multiplex a
  proxied request and collect the response (buffer or stream).
- **`createTunnelForwarder({ registry, base })`** — a `ProxyForwarder` that routes any target with
  `transport: 'tunnel'` over the registry, and delegates everything else to the base (fetch)
  forwarder. The customer engine URL/key is never used on the tunnel path.

Plug it into the generic proxy by giving the resolver a `transport: 'tunnel'` target
([Generic proxy](proxy.md)):

```ts
createProxyForwarder(...)        // base (direct) forwarder
createTunnelForwarder({ registry, base });
```

## Framing

One `CONNECT` stream carries framed messages: `request` (method/path/query/headers/`body`), then
`response-start`, zero or more `data` chunks, and `response-end` (or `error`). Bodies are base64 so
binary and JSON payloads share the stream; streaming responses (server-sent events) flow as successive
`data` frames.

## Next

- [Generic proxy](proxy.md) — the routing layer that selects `transport: 'tunnel'`
- [Live events (SSE)](events.md) — streamed over a tunnel just like any other response

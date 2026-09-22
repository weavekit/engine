# Generic proxy

The engine can act as a **gateway** to other running instances — most often a customer's self-hosted
engine reached from a governance side. The proxy is deliberately generic: it forwards a request to a
resolved target, and access is gated by a **path-prefix allowlist**, not by enumerating resources.
New engine or business REST surfaces become reachable by widening the allowlist, without touching the
proxy routes.

```
GET    {prefix}/proxy                        list targets the subject may reach
GET    {prefix}/proxy/:instance/*            read passthrough
POST   {prefix}/proxy/:instance/*            write passthrough
PATCH  {prefix}/proxy/:instance/*
PUT    {prefix}/proxy/:instance/*
DELETE {prefix}/proxy/:instance/*
```

## Targets and the resolver

The engine never reads tables to find a target — the application layer injects a resolver:

```ts
export default {
  proxy: {
    resolver: {
      // return the target for this instance, or null (→ 404)
      async resolve(instance, subject) { /* app-specific lookup + access rule */ },
      // optional: targets the subject may list (GET /proxy)
      async list(subject) { /* … */ },
    },
  },
};
```

A `ProxyTarget` is:

```ts
{
  id: string;            // = :instance; the connection id in the app layer
  url: string;           // target base URL (used for `direct`)
  transport?: string;    // 'direct' | 'tunnel' | 'cloud'
  apiKey: string;        // the key used to call the target — never sent to the browser
  keyScope?: 'read' | 'admin';
  allow?: ProxyAllow;    // per-target allowlist override
  labels?: Record<string, string>;
}
```

## Access rules

- **Path gate** — `isAllowedProxyPath(method, path, allow)`: `GET` is checked against `allow.read`,
  every other method against `allow.write`. Paths are normalized to segments; traversal (`..`),
  blank segments, backslashes and percent-encoding are rejected.
- **Per-target allowlist** — a target with no `allow` is **deny-all**. The application writes the
  default explicitly from `DEFAULT_PROXY_ALLOW`
  (`read: audit/metadata/permissions/identities/guardrails/approvals/events/objects`, `write: approvals`).
- **Writes are stricter** — a write also requires `target.keyScope === 'admin'` *and* the caller to
  hold a role in `adapters.rest.adminRoles`. Every depth-2 write is audited as `proxy.<method>`.

## Forwarding

The runtime forwarder issues the outbound call and re-validates the path as defense in depth (only
`[A-Za-z0-9_/.-]`). The target's `apiKey` is set as the upstream `Authorization: Bearer` and is never
replayed to the browser. A buffered forward has a **10s timeout** and a **1 MiB response cap**.

Streaming is supported: when the request asks for `text/event-stream`, the upstream body is piped
through (no timeout) and the client's `last-event-id` is passed upstream so the target can replay.
With a `tunnel` transport the request is multiplexed over the live connector session instead of a
`fetch` — see [Tunnel transport](tunnel.md).

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `proxy.denied` | 403 | path outside the allowlist, or the write/key-scope/admin gate failed |
| `proxy.notFound` | 404 | the resolver returned no target |
| `proxy.unreachable` | 502 | the upstream could not be reached |
| `proxy.timeout` | 504 | the upstream took longer than the forward timeout |
| `proxy.responseTooLarge` | 502 | the upstream body exceeded the cap |

## Next

- [Tunnel transport](tunnel.md) — reach a target with no routable URL
- [Public API & dependency budget](../reference/public-api.md) — the `core/proxy` contract

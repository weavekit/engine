# Inbound events (ingress)

The live event channel (`/api/events`) is **outbound**: the engine tells subscribers what changed.
Ingress is the opposite direction — an external system pushes an event **into** the engine, such as a
payment callback, an HR change, or a ticket status update.

The engine provides the **mechanism** only: an HTTP entry point, the exact raw body for signature
verification, per-source rate limiting, and an audit receipt. **Provider semantics — how to verify
and what to do — stay in your application.** The engine maps nothing, so it never turns into a
provider-specific adapter.

## Enable

```ts
// weavekit.config.ts
export default {
  // …
  ingress: {
    rateLimit: { windowMs: 60_000, max: 120 }, // optional, per source
    verifier: async ({ source, headers, rawBody }) => {
      // your auth — e.g. an HMAC over the exact raw body
      if (!verifyHmac(headers['x-signature'], rawBody, process.env.BILLING_SECRET!)) return null;
      const body = JSON.parse(rawBody);
      return { source, type: body.type, id: body.id, payload: body };
    },
    handler: async (event, { audit }) => {
      // your mapping/routing — the engine deliberately has none
      await routeExternalEvent(event);
    },
  },
} satisfies EngineConfig;
```

## Endpoint

```
POST {prefix}/ingress/:source      # prefix defaults to /api
```

| Result | Meaning |
| --- | --- |
| `202 { accepted: true }` | verified (the handler ran); receipt audited as `ingress.<source>` |
| `401` | `verifier` returned `null` (fail-closed; unknown/bad signature) |
| `429` | per-source rate limit exceeded |

- The request body must be JSON, and the **raw bytes** are preserved for signature verification (`rawBody`), so an HMAC computed over the wire bytes matches.
- The engine ships **no** verifier or mapping. An ingress is only registered when `config.ingress` is set; without a `verifier`, the route is never exposed.
- Idempotency is the application's concern. `InboundEvent.id` is passed through for your dedupe store.

## Relationship to `tool`/`script`

Ingress is the asynchronous, JSON-over-HTTP counterpart to the synchronous tool surface: use tools
when the agent calls *you*, and ingress when a provider calls *you*. Neither replaces the other.

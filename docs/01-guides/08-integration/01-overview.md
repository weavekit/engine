---
title: Integration
description: "Talking to other systems: live SSE events, inbound webhooks, the generic proxy, and the tunnel transport."
---

# Integration

Moving data and signals in and out. Live push to clients, inbound webhooks, and two ways to reach an
engine that isn't directly routable.

- [Live events (SSE)](02-events.md) — push data and metadata changes to clients
- [Inbound events](03-ingress.md) — signed webhooks mapped to engine actions
- [Generic proxy](04-proxy.md) — a path-allowlisted gateway to other instances
- [Tunnel transport](05-tunnel.md) — reach a NAT'd engine over an outbound HTTP/2 tunnel

import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import type { ProxyRequest, ProxyResponse, ProxyTarget } from '../../core/proxy/index.js';
import type { ProxyForwarder, ProxyStream } from '../../runtime/proxy/index.js';
import type { TunnelFrame } from './framing.js';
import { toB64 } from './framing.js';
import type { TunnelRegistry } from './registry.js';

/**
 * Tunnel-aware proxy forwarder (MIT): for a `target.transport === 'tunnel'`
 * it multiplexes the proxied request over the live connector session in the
 * {@link TunnelRegistry} (instead of `fetch(url)`); for `direct` (and anything
 * else) it delegates to the passed base forwarder. The customer engine url/key
 * is never used on the tunnel path — the connector performs the outbound call.
 */

let ticket = 0;
const nextId = (): number => (ticket += 1);

export interface TunnelForwarderOptions {
  registry: TunnelRegistry;
  /** base (fetch) forwarder used for non-tunnel targets. */
  base: ProxyForwarder;
  locale?: Locale;
}

function toRequestFrame(req: ProxyRequest): Extract<TunnelFrame, { kind: 'request' }> {
  return {
    kind: 'request',
    id: nextId(),
    method: req.method,
    path: req.path,
    query: encodeQuery(req.query),
    headers: { ...req.headers },
    ...(req.body === undefined ? {} : { body: toB64(new TextEncoder().encode(JSON.stringify(req.body))) }),
  };
}

export function encodeQuery(query: Record<string, string | undefined> | undefined): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) qs.set(k, v);
  }
  return qs.toString();
}

function parseBody(res: { status: number; headers: Record<string, string>; body: string }): unknown {
  const contentType = res.headers['content-type'] ?? '';
  if (contentType.includes('json')) {
    try {
      return res.body === '' ? undefined : JSON.parse(res.body);
    } catch {
      return res.body;
    }
  }
  return res.body;
}

export function createTunnelForwarder(options: TunnelForwarderOptions): ProxyForwarder {
  const { registry, base, locale } = options;
  const loc = locale ?? 'en';

  return {
    async forward(target: ProxyTarget, req: ProxyRequest): Promise<ProxyResponse> {
      if (target.transport !== 'tunnel') return base.forward(target, req);
      const res = await registry.request(target.id, toRequestFrame(req));
      if (res.status === 503 || res.status === 499) {
        throw new SchemaError('proxy.unreachable', { instance: req.instance, target: target.id }, loc);
      }
      return { status: res.status, body: parseBody(res) };
    },

    async forwardStream(target: ProxyTarget, req: ProxyRequest): Promise<ProxyStream> {
      if (target.transport !== 'tunnel') return base.forwardStream(target, req);
      const { response, abort } = await registry.openStream(target.id, toRequestFrame(req));
      return { response, abort };
    },
  };
}

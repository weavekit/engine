import { SchemaError } from '../../core/types/errors.js';
import { DEFAULT_LOCALE, type Locale } from '../../core/i18n/index.js';
import type { ProxyTarget, ProxyRequest, ProxyResponse } from '../../core/proxy/types.js';

/**
 * Outbound fetch forwarder for the engine generic proxy (P-2). Lives in the
 * runtime layer (real IO) — core stays IO-free per the proxy contract.
 *
 * Security: this is the wrapper that actually issues the network call, so it
 * re-validates the path (defense in depth on top of `isAllowedProxyPath`):
 * only `[A-Za-z0-9_/.-]`, no `..`/blank segments, no percent-encoding. The
 * customer-engine api key is set as a Bearer header and NEVER leaks to the
 * browser. No non-Bearer/remote headers are replayed.
 */

export interface ProxyForwarder {
  /** buffered forward → `{status, body}` (reads a bounded body; JSON for json responses). */
  forward(target: ProxyTarget, req: ProxyRequest): Promise<ProxyResponse>;
  /** streaming forward → the raw upstream `Response` (for SSE): caller pipes the body and calls `abort()` on teardown. */
  forwardStream(target: ProxyTarget, req: ProxyRequest): Promise<ProxyStream>;
}

/** a streaming forward handle: the upstream response + how to cancel it. */
export interface ProxyStream {
  response: Response;
  abort(): void;
}

export interface ProxyForwarderOptions {
  /** injectable fetch (tests) — defaults to the runtime global. */
  fetchImpl?: typeof fetch;
  /** per-request timeout (default 10_000ms; not applied to `forwardStream` — SSE is long-lived). */
  timeoutMs?: number;
  /** response body cap in bytes (default 1 MiB) to prevent large replay. */
  maxBodyBytes?: number;
  /** REST path prefix joined onto the target (default `/api`). */
  pathPrefix?: string;
  locale?: Locale;
}

/** path whitelist: only engine-REST-safe chars (blocks SSRF/traversal/encoding). */
const SAFE_PATH = /^[A-Za-z0-9_/.-]*$/;

function safePath(raw: string): string | null {
  if (!SAFE_PATH.test(raw)) return null;
  let p = raw;
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') return '';
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return null;
  }
  return p;
}

export function createProxyForwarder(opts: ProxyForwarderOptions = {}): ProxyForwarder {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const pathPrefix = opts.pathPrefix ?? '/api';
  const locale = opts.locale ?? DEFAULT_LOCALE;

  function buildUrl(target: ProxyTarget, path: string): URL {
    const base = new URL(target.url);
    const normPrefix = pathPrefix.startsWith('/') ? pathPrefix.replace(/\/+$/, '') : `/${pathPrefix}`;
    const normPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    const basePath = base.pathname.replace(/\/+$/, '');
    return new URL(`${basePath}${normPrefix}${normPath}`.replace(/\/{2,}/g, '/') || '/', base.origin);
  }

  async function throwOnUnsafe(target: ProxyTarget, req: ProxyRequest): Promise<string> {
    const safe = safePath(req.path);
    if (safe === null) {
      throw new SchemaError('proxy.denied', { instance: req.instance, target: target.id }, locale);
    }
    return safe;
  }

  /** build the outbound URL/headers/body shared by buffered + streaming forward. */
  function composeRequest(
    target: ProxyTarget,
    safe: string,
    req: ProxyRequest,
  ): { url: URL; method: ProxyRequest['method']; headers: Record<string, string>; body: string | undefined } {
    const url = buildUrl(target, safe);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) qs.set(k, v);
    }
    if (qs.size > 0) url.search = qs.toString();

    // extra passthrough headers first (e.g. `last-event-id`); the customer key is authoritative
    const headers: Record<string, string> = { ...req.headers };
    headers.Authorization = `Bearer ${target.apiKey}`;
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    return { url, method: req.method, headers, body };
  }

  async function open(target: ProxyTarget, req: ProxyRequest, controller?: AbortController): Promise<Response> {
    const safe = await throwOnUnsafe(target, req);
    const { url, method, headers, body } = composeRequest(target, safe, req);
    return fetchImpl(url, {
      method,
      headers,
      body,
      ...(controller === undefined ? {} : { signal: controller.signal }),
    });
  }

  return {
    async forward(target, req): Promise<ProxyResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await open(target, req, controller);
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof SchemaError) throw error; // e.g. proxy.denied from path validation
        if (controller.signal.aborted) {
          throw new SchemaError('proxy.timeout', { instance: req.instance, timeout: timeoutMs }, locale);
        }
        throw new SchemaError('proxy.unreachable', { instance: req.instance, target: target.id }, locale);
      }
      clearTimeout(timer);

      const text = await readBounded(resp, target, req, maxBodyBytes, locale);
      let parsed: unknown = text;
      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = text;
        }
      }
      return { status: resp.status, body: parsed };
    },

    async forwardStream(target, req): Promise<ProxyStream> {
      // long-lived SSE: no timeout (heartbeats keep it alive); teardown is via abort()
      const controller = new AbortController();
      let resp: Response;
      try {
        resp = await open(target, req, controller);
      } catch (error) {
        if (error instanceof SchemaError) throw error; // e.g. proxy.denied from path validation
        if (controller.signal.aborted) {
          throw new SchemaError('proxy.timeout', { instance: req.instance, timeout: timeoutMs }, locale);
        }
        throw new SchemaError('proxy.unreachable', { instance: req.instance, target: target.id }, locale);
      }
      if (resp.body === null) {
        throw new SchemaError('proxy.unreachable', { instance: req.instance, target: target.id }, locale);
      }
      return { response: resp, abort: () => controller.abort() };
    },
  };
}

async function readBounded(
  resp: Response,
  target: ProxyTarget,
  req: ProxyRequest,
  maxBodyBytes: number,
  locale: Locale,
): Promise<string> {
  const contentLength = Number(resp.headers.get('content-length') ?? '0');
  if (contentLength > maxBodyBytes) {
    throw new SchemaError('proxy.responseTooLarge', { instance: req.instance, target: target.id, max: maxBodyBytes }, locale);
  }
  const text = await resp.text();
  if (Buffer.byteLength(text) > maxBodyBytes) {
    throw new SchemaError('proxy.responseTooLarge', { instance: req.instance, target: target.id, max: maxBodyBytes }, locale);
  }
  return text;
}

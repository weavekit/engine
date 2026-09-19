import { connect as http2Connect } from 'node:http2';
import { TunnelSession } from './framing.js';
import { fromB64, toB64 } from './framing.js';
import type { TunnelFrame } from './framing.js';

/**
 * Connector / agent (P1, MIT): the customer-side outbound half of the tunnel.
 * Runs beside the customer engine, dials the governance tunnel endpoint over a
 * persistent HTTP/2 CONNECT stream, and forwards each proxied request the
 * governance side sends to the local engine via `fetch`. Responses (including
 * SSE streams) are chunked back as `data` frames.
 *
 * The connector only ever reaches the customer engine on localhost — the
 * governance side routes by `tunnel_id` and never needs a routable `url`.
 */

export interface ConnectorOptions {
  /** governance tunnel endpoint, e.g. `http://127.0.0.1:3010` (h2c) or `https://...`. */
  endpoint: string;
  tunnelId: string;
  pairingToken: string;
  /** local customer engine base url, e.g. `http://localhost:3000`. */
  engineUrl: string;
  /** customer engine api key used as the outbound Bearer (auth to the local engine). */
  engineApiKey: string;
  /** engine REST path prefix (default `/api`). */
  pathPrefix?: string;
  /** skip TLS certificate verification (dev/self-hosted h2c or self-signed). */
  insecure?: boolean;
}

export interface ConnectorHandle {
  /** resolves when the tunnel handshake returns 200, rejects otherwise. */
  ready: Promise<void>;
  close(): void;
}

export function connectTunnel(opts: ConnectorOptions): ConnectorHandle {
  const pathPrefix = opts.pathPrefix ?? '/api';
  const session = http2Connect(opts.endpoint, {
    ...(opts.insecure === true ? { rejectUnauthorized: false } : {}),
  });
  const authority = new URL(opts.endpoint).host;
  const headers: Record<string, string> = {
    ':method': 'CONNECT',
    ':authority': authority,
    'x-weavekit-tunnel': opts.tunnelId,
    authorization: `Bearer ${opts.pairingToken}`,
  };
  const stream = session.request(headers);
  const tunnel = new TunnelSession(stream as unknown as import('node:stream').Duplex);
  let closed = false;

  const ready = new Promise<void>((resolve, reject) => {
    const onResponse = (h: Record<string, unknown>): void => {
      const status = Number(h[':status'] ?? 0);
      if (status === 200) resolve();
      else reject(new Error(`tunnel handshake failed: ${status}`));
    };
    stream.once('response', onResponse);
    stream.once('error', reject);
    stream.once('close', () => {
      if (!closed) {
        closed = true;
        reject(new Error('tunnel closed before handshake'));
      }
    });
  });

  void readLoop();

  async function readLoop(): Promise<void> {
    try {
      for (;;) {
        const frame = await tunnel.read();
        if (frame === null) break;
        if (frame.kind === 'request') void handleRequest(frame);
        // `cancel` is advisory; individual in-flight handlers track it implicitly
      }
    } catch {
      // peer dropped — stop
    } finally {
      closed = true;
      session.close();
    }
  }

  async function handleRequest(frame: Extract<TunnelFrame, { kind: 'request' }>): Promise<void> {
    const url = buildEngineUrl(opts.engineUrl, pathPrefix, frame);
    // the governance side serializes JSON request bodies → decode to a string here
    const body = frame.body === undefined ? undefined : new TextDecoder().decode(fromB64(frame.body));
    const reqHeaders: Record<string, string> = { ...frame.headers };
    reqHeaders.authorization = `Bearer ${opts.engineApiKey}`;
    if (body !== undefined && reqHeaders['content-type'] === undefined) reqHeaders['content-type'] = 'application/json';

    let resp: Response;
    try {
      resp = await fetch(url, { method: frame.method, headers: reqHeaders, body });
    } catch (error) {
      tunnel.write({ kind: 'error', id: frame.id, message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (closed) return;
    tunnel.write({ kind: 'response-start', id: frame.id, status: resp.status, headers: Object.fromEntries(resp.headers.entries()) });
    if (resp.body === null) {
      tunnel.write({ kind: 'response-end', id: frame.id });
      return;
    }
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tunnel.write({ kind: 'data', id: frame.id, data: toB64(value as Uint8Array) });
      }
      tunnel.write({ kind: 'response-end', id: frame.id });
    } catch (error) {
      tunnel.write({ kind: 'error', id: frame.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    ready,
    close(): void {
      closed = true;
      tunnel.close();
      session.close();
    },
  };
}

function buildEngineUrl(
  engineUrl: string,
  pathPrefix: string,
  frame: Extract<TunnelFrame, { kind: 'request' }>,
): string {
  if (typeof URL !== 'undefined') {
    const base = new URL(engineUrl);
    const prefix = pathPrefix.replace(/\/+$/, '');
    const basePath = base.pathname.replace(/\/+$/, '');
    const path = frame.path.startsWith('/') ? frame.path : `/${frame.path}`;
    base.pathname = `${basePath}${prefix}${path}`.replace(/\/{2,}/g, '/') || '/';
    base.search = frame.query;
    return base.toString();
  }
  return `${engineUrl.replace(/\/+$/, '')}${pathPrefix}${frame.path}${frame.query ? `?${frame.query}` : ''}`;
}

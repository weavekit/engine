import { createServer } from 'node:http2';
import type { Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { TunnelSession } from './framing.js';
import type { TunnelRegistry } from './registry.js';

/**
 * Tunnel endpoint (P1, MIT): a node:http2 server the customer's `weave connect`
 * agent dials OUT to. Each CONNECT stream authenticated by `(tunnel_id,
 * pairing_token)` becomes a live {@link TunnelSession} registered in the
 * {@link TunnelRegistry}, which the governance proxy forwarder then routes
 * proxied requests over. The server accepts h2c (prior-knowledge) or TLS
 * (`secure`), so it can live beside the governance engine or behind a TLS
 * terminator.
 */

export interface TunnelServerDeps {
  registry: TunnelRegistry;
  /** validate a connector's `(tunnel_id, pairing_token)` before accepting. */
  authenticate(tunnelId: string, token: string): Promise<boolean> | boolean;
}

export interface TunnelServerHandle {
  listen(port: number, host?: string): Promise<number>;
  address(): { port: number };
  close(): Promise<void>;
}

function bearerOf(authorization: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (value === undefined || !value.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

export function createTunnelServer(deps: TunnelServerDeps): TunnelServerHandle {
  const server: Http2Server = createServer();

  server.on('stream', (stream, headers) => {
    void (async () => {
      try {
        if (headers[':method'] !== 'CONNECT') {
          stream.respond({ ':status': 405 });
          stream.end();
          return;
        }
        const tunnelId = headerValue(headers['x-weavekit-tunnel']);
        const token = bearerOf(headers.authorization);
        if (tunnelId === undefined || token === undefined) {
          stream.respond({ ':status': 401 });
          stream.end();
          return;
        }
        const ok = await deps.authenticate(tunnelId, token);
        if (!ok) {
          stream.respond({ ':status': 403 });
          stream.end();
          return;
        }
        const session = new TunnelSession(stream);
        deps.registry.register(tunnelId, session);
        stream.respond({ ':status': 200 });
        // the stream stays open; unregister the stale session when the peer drops
        stream.on('close', () => deps.registry.unregister(tunnelId, session));
      } catch {
        try {
          stream.respond({ ':status': 500 });
          stream.end();
        } catch {
          /* already gone */
        }
      }
    })();
  });

  const portOf = (): number => {
    const addr = server.address();
    return typeof addr === 'object' && addr !== null ? (addr as AddressInfo).port : 0;
  };

  return {
    listen(port: number, host = '127.0.0.1'): Promise<number> {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(portOf()));
      });
    },
    address() {
      return { port: portOf() };
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

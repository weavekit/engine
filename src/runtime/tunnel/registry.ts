import { Readable } from 'node:stream';
import type { TunnelFrame, TunnelSession } from './framing.js';
import { fromB64 } from './framing.js';

/**
 * Registry of live connector sessions keyed by `tunnel_id` (= connections id for
 * `transport: 'tunnel'`). A tunnel is a full-duplex HTTP/2 CONNECT stream; the
 * `TunnelRegistry` owns the reader loop and dispatches every inbound frame to the
 * waiter correlated by frame `id`, so many proxied requests (buffered or SSE) can
 * be in flight concurrently over one tunnel.
 */

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Waiter {
  onStart(status: number, headers: Record<string, string>): void;
  onData(chunk: Uint8Array): void;
  onEnd(): void;
  onError(message: string): void;
  onCancel(): void;
}

interface Entry {
  session: TunnelSession;
  waiters: Map<number, Waiter>;
}

export class TunnelRegistry {
  private readonly entries = new Map<string, Entry>();

  register(tunnelId: string, session: TunnelSession): void {
    this.entries.get(tunnelId)?.session.close();
    const entry: Entry = { session, waiters: new Map() };
    this.entries.set(tunnelId, entry);
    void this.readLoop(tunnelId, entry);
  }

  get(tunnelId: string): TunnelSession | undefined {
    return this.entries.get(tunnelId)?.session;
  }

  has(tunnelId: string): boolean {
    return this.entries.has(tunnelId);
  }

  unregister(tunnelId: string, session: TunnelSession): void {
    const entry = this.entries.get(tunnelId);
    if (entry !== undefined && entry.session === session) this.entries.delete(tunnelId);
  }

  /** Send one buffered request frame and resolve with the complete response. */
  async request(tunnelId: string, frame: Extract<TunnelFrame, { kind: 'request' }>): Promise<TunnelResponse> {
    const entry = this.entries.get(tunnelId);
    if (entry === undefined) return { status: 503, headers: {}, body: JSON.stringify({ error: 'tunnel offline' }) };
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let status = 0;
      let headers: Record<string, string> = {};
      let settled = false;
      const settle = (value: TunnelResponse): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      entry.waiters.set(frame.id, {
        onStart(s, h) {
          status = s;
          headers = h;
        },
        onData(chunk) {
          chunks.push(chunk);
        },
        onEnd() {
          settle({ status, headers, body: Buffer.concat(chunks).toString('utf8') });
        },
        onError(message) {
          settle({ status: 502, headers: {}, body: JSON.stringify({ error: message }) });
        },
        onCancel() {
          settle({ status: 499, headers: {}, body: JSON.stringify({ error: 'cancelled' }) });
        },
      });
      entry.session.write(frame);
    });
  }

  /** Open a streaming (SSE) request: resolve on response-start with `{ response, abort }`. */
  openStream(
    tunnelId: string,
    frame: Extract<TunnelFrame, { kind: 'request' }>,
  ): Promise<{ response: Response; abort: () => void }> {
    const entry = this.entries.get(tunnelId);
    if (entry === undefined) {
      return Promise.reject(new Error('tunnel offline'));
    }
    return new Promise((resolve, reject) => {
      let cleared = false;
      const chunks: Uint8Array[] = [];
      let pushed = false;
      const readable = new Readable({
        read() {
          /* data pushed below */
        },
      });
      const push = (): void => {
        if (chunks.length > 0 && !cleared) {
          readable.push(Buffer.concat(chunks));
          chunks.length = 0;
          if (!readable.readableFlowing) readable.resume(); // keep the consumer flowing
        }
      };
      const fail = (err: Error): void => {
        if (!pushed) reject(err);
        else readable.destroy(err);
      };
      entry.waiters.set(frame.id, {
        onStart(s, h) {
          if (!pushed) {
            pushed = true;
            resolve({
              response: new Response(Readable.toWeb(readable) as unknown as ReadableStream, { status: s, headers: h }),
              abort: () => {
                entry.session.write({ kind: 'cancel', id: frame.id });
                readable.destroy();
              },
            });
          }
          push();
        },
        onData(chunk) {
          chunks.push(chunk);
          push();
        },
        onEnd() {
          cleared = true;
          readable.push(null);
        },
        onError(message) {
          fail(new Error(message));
        },
        onCancel() {
          cleared = true;
          readable.push(null);
        },
      });
      entry.session.write(frame);
    });
  }

  close(tunnelId: string): void {
    const entry = this.entries.get(tunnelId);
    if (entry !== undefined) {
      entry.session.close();
      this.entries.delete(tunnelId);
    }
  }

  closeAll(): void {
    for (const [id, entry] of this.entries) {
      entry.session.close();
      this.entries.delete(id);
    }
  }

  private async readLoop(tunnelId: string, entry: Entry): Promise<void> {
    try {
      for (;;) {
        const frame = await entry.session.read();
        if (frame === null) break;
        this.route(entry, frame);
      }
    } finally {
      for (const waiter of entry.waiters.values()) waiter.onEnd();
      this.unregister(tunnelId, entry.session);
    }
  }

  private route(entry: Entry, frame: TunnelFrame): void {
    if (frame.kind === 'response-start' || frame.kind === 'data' || frame.kind === 'response-end' || frame.kind === 'error') {
      const waiter = entry.waiters.get(frame.id);
      if (waiter === undefined) return;
      if (frame.kind === 'response-start') waiter.onStart(frame.status, frame.headers);
      else if (frame.kind === 'data') waiter.onData(fromB64(frame.data));
      else if (frame.kind === 'error') waiter.onError(frame.message);
      else {
        waiter.onEnd();
        entry.waiters.delete(frame.id);
      }
    }
  }
}

import type { FastifyReply } from 'fastify';
import type { EngineEvent } from '../../core/provider/event/index.js';

/**
 * SSE stream over a hijacked fastify reply. Writes `id`/`event`/`data` blocks,
 * sends a keep-alive `: ping` comment on an interval, and tears down cleanly on
 * client disconnect (the raw socket 'close' event).
 */

export interface SseStreamOptions {
  /** keep-alive ping interval; defaults to 30s */
  heartbeatMs?: number;
  /** fired when the underlying connection closes */
  onClose?: () => void;
  /**
   * CORS origin to allow (mirrors `adapters.rest.cors.origin`). The SSE response
   * is hijacked, which bypasses the @fastify/cors onSend hook — so the header is
   * written here for cross-origin frontends (real-time via `client.subscribe`).
   * `true` reflects the request origin; a string[] echoes it when allowed.
   */
  corsOrigin?: string | string[] | boolean;
}

export interface SseStream {
  /** write one bus event as an SSE block (carries its `seq` as the event id) */
  write(event: EngineEvent): void;
  /** write a raw named SSE event without a seq id (e.g. the replay-gap nudge) */
  writeRaw(eventName: string, data: unknown): void;
  close(): void;
}

/** resolve the Access-Control-Allow-Origin value for a request (cors origin semantics) */
function allowOrigin(cors: string | string[] | boolean | undefined, requestOrigin: string | undefined): string | undefined {
  if (cors === undefined || cors === false) return undefined;
  if (cors === true) return requestOrigin;
  if (typeof cors === 'string') return cors;
  return requestOrigin !== undefined && cors.includes(requestOrigin) ? requestOrigin : undefined;
}

export function createSseStream(reply: FastifyReply, options: SseStreamOptions = {}): SseStream {
  const raw = reply.raw;
  let closed = false;
  const heartbeatMs = options.heartbeatMs ?? 30_000;

  const headers: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
  const origin = allowOrigin(options.corsOrigin, reply.request.headers.origin);
  if (origin !== undefined) headers['access-control-allow-origin'] = origin;
  raw.writeHead(200, headers);
  raw.flushHeaders();
  raw.setTimeout(0);

  const heartbeat = setInterval(() => {
    if (!closed) raw.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  raw.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    options.onClose?.();
  });

  return {
    write(event: EngineEvent): void {
      if (closed) return;
      const data = JSON.stringify({
        seq: event.seq,
        ts: event.ts.toISOString(),
        type: event.type,
        payload: event.payload,
      });
      raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`);
    },
    writeRaw(eventName: string, data: unknown): void {
      if (closed) return;
      raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close(): void {
      if (!closed) {
        closed = true;
        clearInterval(heartbeat);
        raw.end();
      }
      // end the underlying socket too — the SSE response advertises
      // keep-alive, so a bare end() would leave the connection open and
      // `server.close()` (via app.close()) would keep waiting on it
      raw.socket?.destroy();
    },
  };
}

import type { Duplex } from 'node:stream';

/**
 * Tunnel framing (MIT): a lightweight length-prefixed JSON codec multiplexed
 * over a full-duplex HTTP/2 `CONNECT` stream. Each frame is
 * `[4-byte big-endian length][JSON payload]`. Both directions (governance →
 * connector and back) use the same `TunnelSession` wrapper, so requests and
 * responses are correlated by a monotonic `id`.
 *
 * Keep it tiny + dependency-free (engine MIT ethos). Body/data are carried as
 * base64 strings so frames are always a single JSON object (no partial binary
 * parsing). Large bodies are chunked by the sender into multiple `data` frames.
 */

export type TunnelFrame =
  | ({
      kind: 'request';
      id: number;
      method: string;
      /** engine REST path under `/api` (whitelisted by the proxy allowlist). */
      path: string;
      query: string;
      headers: Record<string, string>;
      /** request body as base64 (absent = no body). */
      body?: string;
    })
  | ({ kind: 'response-start'; id: number; status: number; headers: Record<string, string> })
  | ({ kind: 'data'; id: number; data: string })
  | ({ kind: 'response-end'; id: number })
  | ({ kind: 'error'; id: number; message: string })
  | ({ kind: 'cancel'; id: number });

const MAX_FRAME = 16 * 1024 * 1024; // sanity cap against a malformed length prefix

export function toB64(input: Uint8Array): string {
  return Buffer.from(input).toString('base64');
}

export function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function encodeFrame(frame: TunnelFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json]);
}

export class TunnelSession {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: TunnelFrame[] = [];
  private readonly waiters: Array<(frame: TunnelFrame | null) => void> = [];
  private closed = false;
  private ended = false;

  constructor(private readonly stream: Duplex) {
    // http2 duplex streams are paused until read; attach listeners to pull bytes
    this.stream.on('data', (chunk: Buffer | string) => this.append(chunk));
    this.stream.on('end', () => this.finish());
    this.stream.on('close', () => this.finish());
    this.stream.on('error', () => {
      /* reader callers observe 'end'/'close' + error frames */
    });
  }

  write(frame: TunnelFrame): void {
    if (this.closed || !this.stream.writable) return;
    this.stream.write(encodeFrame(frame));
  }

  /** Read the next complete frame; `null` when the peer ends/closes the stream. */
  read(): Promise<TunnelFrame | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.stream.destroy();
  }

  private append(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.parseAll();
    this.drain();
  }

  private parseAll(): void {
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('tunnel frame too large');
      if (this.buffer.length < 4 + len) return;
      const payload = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        this.queue.push(JSON.parse(payload.toString('utf8')) as TunnelFrame);
      } catch {
        // malformed frame — drop and continue
      }
    }
  }

  private drain(): void {
    while (this.queue.length > 0 && this.waiters.length > 0) {
      this.waiters.shift()!(this.queue.shift()!);
    }
    if (this.ended && this.queue.length === 0 && this.waiters.length > 0) {
      while (this.waiters.length > 0) this.waiters.shift()!(null);
    }
  }

  private finish(): void {
    this.ended = true;
    this.drain();
  }
}

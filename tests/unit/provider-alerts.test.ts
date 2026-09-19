import { describe, it, expect, afterEach } from '../helpers/test.js';import { createServer, type Server } from 'node:http';
import { ALERT_LEVELS } from '../../src/core/provider/alerts/index.js';
import type { AlertLevel, FetchLike } from '../../src/core/provider/alerts/index.js';
import {
  createAlerts,
  createConsoleAlertSink,
  createSlackAlertSink,
  createWebhookAlertSink,
} from '../../src/infrastructure/alerts/index.js';

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => s.close(resolve));
  }
});

function captureConsole(): { calls: Array<[AlertLevel, string]>; restore: () => void } {
  const calls: Array<[AlertLevel, string]> = [];
  const origWarn = console.warn;
  const origError = console.error;
  const warn = (msg?: unknown): void => {
    calls.push(['warn', String(msg)]);
  };
  const error = (msg?: unknown): void => {
    calls.push(['error', String(msg)]);
  };
  console.warn = warn as typeof console.warn;
  console.error = error as typeof console.error;
  return {
    calls,
    restore: () => {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

describe('createConsoleAlertSink', () => {
  it('warn/error route to console.warn / console.error by level', async () => {
    const { calls, restore } = captureConsole();
    try {
      const sink = createConsoleAlertSink();
      await sink.alert(ALERT_LEVELS.WARN, 'rate limit exceeded', { key: 'sk-a' });
      await sink.alert(ALERT_LEVELS.ERROR, 'boom', { key: 'sk-a' });
      expect(calls[0]![0]).toBe('warn');
      expect(calls[0]![1]).toContain('rate limit exceeded');
      expect(calls[0]![1]).toContain('sk-a');
      expect(calls[1]![0]).toBe('error');
      expect(calls[1]![1]).toContain('boom');
    } finally {
      restore();
    }
  });
});

describe('createWebhookAlertSink', () => {
  it('POST {level,message,meta,ts} JSON to url (node:http local endpoint end-to-end)', async () => {
    let received: { url: string; method: string; body: unknown } | undefined;
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on('end', () => {
        received = { url: req.url ?? '', method: req.method ?? '', body: JSON.parse(data) };
        res.statusCode = 200;
        res.end('ok');
      });
    });
    const base = await listen(server);
    servers.push(server);

    const sink = createWebhookAlertSink({ url: `${base}/hooks/alerts` });
    await sink.alert(ALERT_LEVELS.WARN, 'high load', { n: 3 });

    expect(received).toBeDefined();
    expect(received!.method).toBe('POST');
    expect(received!.url).toBe('/hooks/alerts');
    const body = received!.body as Record<string, unknown>;
    expect(body.level).toBe('warn');
    expect(body.message).toBe('high load');
    expect(body.meta).toEqual({ n: 3 });
    expect(typeof body.ts).toBe('string');
  });

  it('non-2xx → throw', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const base = await listen(server);
    servers.push(server);

    const sink = createWebhookAlertSink({ url: `${base}/x` });
    await expect(sink.alert(ALERT_LEVELS.ERROR, 'bad')).rejects.toThrow(/500/);
  });

  it('inject mock fetch: validates body and timeout signal; network failure throws', async () => {
    const seen: Array<{ init: RequestInit }> = [];
    const mockFetch: FetchLike = async (_url, init) => {
      seen.push({ init: init! });
      return new Response('{}', { status: 200 });
    };
    const sink = createWebhookAlertSink({ url: 'https://example.invalid/hook', fetch: mockFetch });
    await sink.alert(ALERT_LEVELS.WARN, 'm');
    expect(seen).toHaveLength(1);
    const init = seen[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
    expect((init.headers as Record<string, string>)['content-type']).toContain('application/json');
  });

  it('AbortSignal.timeout passed in; timeout triggers AbortError and throws', async () => {
    const mockFetch: FetchLike = async (_url, init) => {
      const signal = init!.signal as AbortSignal;
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout not triggered')), 200);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
      return new Response('{}', { status: 200 });
    };
    const sink = createWebhookAlertSink({ url: 'https://example.invalid/hook', timeoutMs: 50, fetch: mockFetch });
    await expect(sink.alert(ALERT_LEVELS.ERROR, 'slow')).rejects.toThrow();
  });
});

describe('createSlackAlertSink', () => {
  it('payload uses Slack incoming webhook format {text, channel, username}', async () => {
    let payload: unknown;
    const mockFetch: FetchLike = async (_url, init) => {
      payload = JSON.parse(String(init!.body));
      return new Response('ok', { status: 200 });
    };
    const sink = createSlackAlertSink({
      webhookUrl: 'https://hooks.slack.com/services/T/B/X',
      channel: '#ops',
      username: 'weavekit',
      fetch: mockFetch,
    });
    await sink.alert(ALERT_LEVELS.ERROR, 'auth spike', { ip: '1.2.3.4' });
    const body = payload as Record<string, unknown>;
    expect(body.channel).toBe('#ops');
    expect(body.username).toBe('weavekit');
    expect(String(body.text)).toContain('[ERROR]');
    expect(String(body.text)).toContain('auth spike');
    expect(String(body.text)).toContain('1.2.3.4');
  });

  it('non-2xx → throw', async () => {
    const mockFetch: FetchLike = async () => new Response('nope', { status: 400 });
    const sink = createSlackAlertSink({ webhookUrl: 'https://hooks.slack.com/x', fetch: mockFetch });
    await expect(sink.alert(ALERT_LEVELS.WARN, 'x')).rejects.toThrow(/400/);
  });
});

describe('createAlerts factory', () => {
  it('no config → console sink', async () => {
    const { calls, restore } = captureConsole();
    try {
      await createAlerts().alert(ALERT_LEVELS.WARN, 'd');
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('channel webhook missing url → throw', async () => {
    expect(() => createAlerts({ channel: 'webhook' })).toThrow(/url/);
  });

  it('channel slack missing webhookUrl → throw', async () => {
    expect(() => createAlerts({ channel: 'slack' })).toThrow(/webhookUrl/);
  });
});

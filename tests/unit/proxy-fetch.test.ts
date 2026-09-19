import { describe, it, expect } from '../helpers/test.js';
import { createProxyForwarder, SchemaError } from '../../src/index.js';

const TARGET = { id: 'conn1', url: 'https://eng.example.com', apiKey: 'secret-key' };

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(resp?: () => Response) {
  const calls: Captured[] = [];
  const mock = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (resp) return resp();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { mock, calls };
}

/** run a forward and capture the (possibly rejected) result */
async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (err) {
    return err;
  }
}

describe('proxy forwarder (mock fetch)', () => {
  it('builds URL and sends the engine api key as a Bearer header', async () => {
    const { mock, calls } = captureFetch();
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const res = await fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' });

    const call = calls[0]!;
    expect(call.url).toBe('https://eng.example.com/api/audit');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    expect(call.init.method).toBe('GET');
    expect(res.status).toBe(200);
  });

  it('joins a trailing-slash base URL and multi-segment path', async () => {
    const { mock, calls } = captureFetch();
    const fwd = createProxyForwarder({ fetchImpl: mock });
    await fwd.forward({ ...TARGET, url: 'https://eng.example.com/' }, {
      instance: 'conn1',
      method: 'GET',
      path: 'metadata/permissions',
    });
    expect(calls[0]!.url).toBe('https://eng.example.com/api/metadata/permissions');
  });

  it('passes through query params and drops undefined values', async () => {
    const { mock, calls } = captureFetch();
    const fwd = createProxyForwarder({ fetchImpl: mock });
    await fwd.forward(TARGET, {
      instance: 'conn1',
      method: 'GET',
      path: 'audit',
      query: { limit: '10', cursor: undefined },
    });
    expect(calls[0]!.url).toBe('https://eng.example.com/api/audit?limit=10');
  });

  it('sends a JSON body for write methods', async () => {
    const { mock, calls } = captureFetch();
    const fwd = createProxyForwarder({ fetchImpl: mock });
    await fwd.forward(TARGET, {
      instance: 'conn1',
      method: 'POST',
      path: 'approvals/key/approve',
      body: { decision: 'approve' },
    });
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ decision: 'approve' });
  });

  it('passes through a non-2xx status with parsed body', async () => {
    const { mock } = captureFetch(() =>
      new Response(JSON.stringify({ error: 'denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const res = await fwd.forward(TARGET, { instance: 'conn1', method: 'POST', path: 'objects/x', body: {} });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'denied' });
  });

  it('parses a JSON response body', async () => {
    const { mock } = captureFetch(() =>
      new Response(JSON.stringify({ count: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const res = await fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' });
    expect(res.body).toEqual({ count: 3 });
  });

  it('normalizes a network error to proxy.unreachable', async () => {
    const mock = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const err = await settle(fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' }));
    expect(err).toMatchObject({ code: 'proxy.unreachable' });
  });

  it('normalizes an abort to proxy.timeout', async () => {
    const mock = (async (_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock, timeoutMs: 5 });
    const err = await settle(fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' }));
    expect(err).toMatchObject({ code: 'proxy.timeout' });
  });

  it('rejects an unsafe (traversal) path as proxy.denied', async () => {
    const mock = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    for (const bad of ['../etc', 'audit/../../x', '//audit', 'audit/./x', '..%2feta', 'a\\b']) {
      const err = await settle(fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: bad }));
      expect(err).toMatchObject({ code: 'proxy.denied' });
    }
  });

  it('never sends the key in the query string', async () => {
    const { mock, calls } = captureFetch();
    const fwd = createProxyForwarder({ fetchImpl: mock });
    await fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' });
    expect(calls[0]!.url).not.toContain('secret-key');
  });

  it('asserts a network error is a SchemaError with code + params', async () => {
    const mock = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const err = await settle(fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: 'audit' }));
    expect(err).toBeInstanceOf(SchemaError);
    expect(err).toMatchObject({ code: 'proxy.unreachable', params: { instance: 'conn1' } });
  });
});

describe('proxy forwarder — forwardStream (SSE)', () => {
  it('returns the upstream Response + an abort handle', async () => {
    const mock = (async () =>
      new Response('data: {"type":"x","payload":{}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const stream = await fwd.forwardStream(TARGET, { instance: 'conn1', method: 'GET', path: 'events' });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.response.body).not.toBeNull();
    expect(typeof stream.abort).toBe('function');
  });

  it('forwards extra headers (last-event-id for replay) and re-validates the path', async () => {
    let captured: Record<string, unknown> | undefined;
    const mock = (async (_input: unknown, init?: RequestInit) => {
      captured = init as unknown as Record<string, unknown>;
      return new Response('data: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    await fwd.forwardStream(TARGET, {
      instance: 'conn1',
      method: 'GET',
      path: 'events',
      headers: { 'last-event-id': '42' },
    });
    expect((captured!.headers as Record<string, string>)['last-event-id']).toBe('42');
    expect((captured!.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('rejects an unsafe path as proxy.denied (not swallowed into unreachable)', async () => {
    const mock = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const err = await settle(fwd.forwardStream(TARGET, { instance: 'conn1', method: 'GET', path: '../etc' }));
    expect(err).toMatchObject({ code: 'proxy.denied' });
  });

  it('plain forward still rethrows proxy.denied from path validation', async () => {
    const mock = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const fwd = createProxyForwarder({ fetchImpl: mock });
    const err = await settle(fwd.forward(TARGET, { instance: 'conn1', method: 'GET', path: '..' }));
    expect(err).toMatchObject({ code: 'proxy.denied' });
  });
});

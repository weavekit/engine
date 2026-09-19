import { describe, it, expect } from '../helpers/test.js';
import Fastify from 'fastify';
import { registerIngressRoutes } from '../../src/adapters/rest/ingress.js';
import { setErrorHandlers } from '../../src/adapters/rest/index.js';
import type { AuditEvent, AuditSink } from '../../src/core/index.js';
import type { InboundEvent, IngressRequest } from '../../src/core/provider/event/index.js';

function captureAudit(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: { record: async (event) => void events.push(event) }, events };
}

describe('registerIngressRoutes', () => {
  it('verifies, handles, audits and returns 202', async () => {
    const app = Fastify();
    setErrorHandlers(app, 'en');
    const { sink, events } = captureAudit();
    const seen: InboundEvent[] = [];
    registerIngressRoutes(
      app,
      { audit: sink, locale: 'en' },
      {
        verifier: (req: IngressRequest): InboundEvent => ({
          source: req.source,
          type: 'invoice.paid',
          id: 'evt_1',
          payload: JSON.parse(req.rawBody),
        }),
        handler: (event) => void seen.push(event),
      },
    );

    const payload = '{\n  "amount": 42,\n  "id": "evt_1"\n}';
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingress/billing',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.source).toBe('billing');
    expect(seen[0]!.type).toBe('invoice.paid');
    expect(seen[0]!.payload).toEqual({ amount: 42, id: 'evt_1' });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('ingress.billing');
    await app.close();
  });

  it('preserves the exact raw body for signature verification', async () => {
    const app = Fastify();
    setErrorHandlers(app, 'en');
    let raw = '';
    registerIngressRoutes(
      app,
      { audit: captureAudit().sink, locale: 'en' },
      {
        verifier: (req) => {
          raw = req.rawBody;
          return { source: req.source, type: 'ping', payload: null };
        },
        handler: () => {},
      },
    );

    const payload = '{ "b": 1,\n  "a": 2 }';
    await app.inject({ method: 'POST', url: '/api/ingress/x', headers: { 'content-type': 'application/json' }, payload });
    expect(raw).toBe(payload);
    await app.close();
  });

  it('rejects an unverified request with 401 (fail-closed)', async () => {
    const app = Fastify();
    setErrorHandlers(app, 'en');
    let handled = 0;
    registerIngressRoutes(
      app,
      { audit: captureAudit().sink, locale: 'en' },
      { verifier: () => null, handler: () => void (handled += 1) },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingress/billing',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(handled).toBe(0);
    await app.close();
  });

  it('rate limits per source with 429', async () => {
    const app = Fastify();
    setErrorHandlers(app, 'en');
    registerIngressRoutes(
      app,
      { audit: captureAudit().sink, locale: 'en', rateLimiter: { check: () => false, clear: () => {} } },
      { verifier: () => ({ source: 'x', type: 'ping', payload: null }), handler: () => {} },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/ingress/x',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });
});

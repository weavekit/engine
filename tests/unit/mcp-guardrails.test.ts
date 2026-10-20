import { describe, it, expect } from '../helpers/test.js';
import { createGuardrails } from '../../src/adapters/mcp/guardrails.js';
import { NOTIFICATION_SEVERITIES } from '../../src/core/provider/notifications/index.js';
import type { NotificationMessage, NotificationSink } from '../../src/core/provider/notifications/index.js';
import type { AuditEvent, AuditSink } from '../../src/core/audit/index.js';

describe('createGuardrails — rate limiting', () => {
  it('passes within window, rejects over limit', () => {
    const alerts: { calls: number } = { calls: 0 };
    const sink: NotificationSink = {
      send: async () => {
        alerts.calls += 1;
      },
    };
    const g = createGuardrails({ rateLimit: { windowMs: 1000, max: 2 }, notifications: sink });
    expect(g.checkRateLimit('key-a', undefined, 0)).toBe(true);
    expect(g.checkRateLimit('key-a', undefined, 10)).toBe(true);
    expect(g.checkRateLimit('key-a', undefined, 20)).toBe(false);
    expect(g.checkRateLimit('key-a', undefined, 30)).toBe(false);
    expect(alerts.calls).toBe(2); // each over-limit sends a warning
    expect(g.checkRateLimit('key-b', undefined, 40)).toBe(true); // independent keys
    g.dispose();
  });

  it('allows passing again after window reset', () => {
    const g = createGuardrails({ rateLimit: { windowMs: 100, max: 1 } });
    expect(g.checkRateLimit('k', undefined, 0)).toBe(true);
    expect(g.checkRateLimit('k', undefined, 50)).toBe(false);
    expect(g.checkRateLimit('k', undefined, 150)).toBe(true); // window slid past 100ms
    g.dispose();
  });

  it('default limits (windowMs 60s, max 100)', () => {
    const g = createGuardrails({});
    for (let i = 0; i < 100; i++) expect(g.checkRateLimit('k')).toBe(true);
    expect(g.checkRateLimit('k')).toBe(false);
    g.dispose();
  });
});

describe('createGuardrails — audit + notifications injection', () => {
  it('audit forwards to injected sink, does not throw on failure', async () => {
    const events: AuditEvent[] = [];
    const audit: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const g = createGuardrails({ audit });
    const event: AuditEvent = { actorType: 'agent', actorId: 'a1', action: 'mcp.tool.search_lead', timestamp: new Date() };
    await g.audit(event);
    expect(events).toHaveLength(1);
    await g.audit(event);
    g.dispose();
  });

  it('audit() does not throw to caller when audit sink throws', async () => {
    const g = createGuardrails({
      audit: {
        record: async () => {
          throw new Error('db down');
        },
      },
    });
    await g.audit({ actorType: 'agent', actorId: 'a1', action: 'mcp.tool.x', timestamp: new Date() });
    g.dispose();
  });

  it('notifications default to console (checkRateLimit still works without injection)', () => {
    const g = createGuardrails({ rateLimit: { windowMs: 1000, max: 1 } });
    expect(g.checkRateLimit('k')).toBe(true);
    expect(g.checkRateLimit('k')).toBe(false);
    g.dispose();
  });

  it('sends a warning notification on over-limit', () => {
    const seen: NotificationMessage[] = [];
    const g = createGuardrails({
      rateLimit: { windowMs: 1000, max: 1 },
      notifications: {
        send: async (message) => {
          seen.push(message);
        },
      },
    });
    g.checkRateLimit('k', undefined, 0);
    g.checkRateLimit('k', undefined, 5);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.severity).toBe(NOTIFICATION_SEVERITIES.WARN);
    expect(seen[0]!.meta).toMatchObject({ kind: 'alert', key: 'k', limit: 1, windowMs: 1000 });
    g.dispose();
  });
});

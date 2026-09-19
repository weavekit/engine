import { describe, it, expect } from '../helpers/test.js';import { createGuardrails } from '../../src/adapters/mcp/guardrails.js';
import { ALERT_LEVELS } from '../../src/core/provider/alerts/index.js';
import type { AlertSink } from '../../src/core/provider/alerts/index.js';
import type { AuditEvent, AuditSink } from '../../src/core/audit/index.js';

describe('createGuardrails — rate limiting', () => {
  it('passes within window, rejects over limit', () => {
    const alerts: { calls: number } = { calls: 0 };
    const sink: AlertSink = {
      alert: async () => {
        alerts.calls += 1;
      },
    };
    const g = createGuardrails({ rateLimit: { windowMs: 1000, max: 2 }, alerts: sink });
    expect(g.checkRateLimit('key-a', undefined, 0)).toBe(true);
    expect(g.checkRateLimit('key-a', undefined, 10)).toBe(true);
    expect(g.checkRateLimit('key-a', undefined, 20)).toBe(false);
    expect(g.checkRateLimit('key-a', undefined, 30)).toBe(false);
    expect(alerts.calls).toBe(2); // each over-limit fires a warn
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

describe('createGuardrails — audit + alerts injection', () => {
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
    await g.audit(event); // sink works
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
    // must not reject even though the sink throws
    await g.audit({ actorType: 'agent', actorId: 'a1', action: 'mcp.tool.x', timestamp: new Date() });
    g.dispose();
  });

  it('alert defaults to console (checkRateLimit still works without injection)', () => {
    const g = createGuardrails({ rateLimit: { windowMs: 1000, max: 1 } });
    expect(g.checkRateLimit('k')).toBe(true);
    expect(g.checkRateLimit('k')).toBe(false); // fires console warn, no crash
    g.dispose();
  });

  it('calls alert(level=warn) on over-limit when alerts injected', async () => {
    const seen: Array<{ level: string; message: string }> = [];
    const g = createGuardrails({
      rateLimit: { windowMs: 1000, max: 1 },
      alerts: {
        alert: async (level, message) => {
          seen.push({ level, message });
        },
      },
    });
    g.checkRateLimit('k', undefined, 0);
    g.checkRateLimit('k', undefined, 5);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.level).toBe(ALERT_LEVELS.WARN);
    g.dispose();
  });
});

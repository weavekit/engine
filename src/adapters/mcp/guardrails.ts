import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { NOOP_AUDIT_SINK } from '../../core/audit/index.js';
import type { NotificationSink } from '../../core/provider/notifications/index.js';
import { NOTIFICATION_SEVERITIES } from '../../core/provider/notifications/index.js';
import { createSlidingWindow, type SlidingWindow } from '../../core/limiter/index.js';

/**
 * Guardrails for the MCP endpoint: per-key sliding-window rate limiting plus
 * injected notification/audit sinks. RBAC is NOT implemented here — it is
 * enforced by the RBAC-decorated data-access layer at call time (see tools.ts).
 *
 * Adapter purity: this module depends on core contracts only. The real sinks
 * are injected by the assembly layer (createEngine).
 */

export interface RateLimitConfig {
  /** sliding window length in ms; defaults to 60_000 */
  windowMs?: number;
  /** max calls per window; defaults to 100 */
  max?: number;
}

export interface McpGuardrails {
  /**
   * Sliding-window check for a key (agent key). Returns true when within the
   * limit. On over-limit it sends a WARN notification and returns false — the
   * caller turns that into an isError tool result. An optional `scope` widens
   * the window key (e.g. `${rolesHash}:${tool}`) so role/tool dimensions get
   * their own windows; scope absent = per-agent credential as before.
   */
  checkRateLimit(key: string, scope?: string, now?: number): boolean;
  /** record a tool-call audit event; failures are caught (audit is best-effort) */
  audit(entry: AuditEvent): Promise<void>;
  /** notification transport for guardrail events (default console) */
  notify: NotificationSink;
  /** release timers/state (no-op in the in-memory implementation) */
  dispose(): void;
}

/** Minimal console transport so the adapter needs no infrastructure import. */
const consoleSink: NotificationSink = {
  async send(message): Promise<void> {
    const meta = message.meta === undefined ? '' : ` ${JSON.stringify(message.meta)}`;
    console.warn(`[weavekit:mcp] ${message.text}${meta}`);
  },
};

export function createGuardrails(options: {
  rateLimit?: RateLimitConfig;
  notifications?: NotificationSink;
  audit?: AuditSink;
}): McpGuardrails {
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const max = options.rateLimit?.max ?? 100;
  const notifications = options.notifications ?? consoleSink;
  const audit = options.audit ?? NOOP_AUDIT_SINK;

  const limiter: SlidingWindow = createSlidingWindow({ windowMs, max });

  function checkRateLimit(key: string, scope?: string, now: number = Date.now()): boolean {
    const windowKey = scope !== undefined ? `${key}:${scope}` : key;
    if (limiter.check(windowKey, now)) return true;
    void notifications.send({
      severity: NOTIFICATION_SEVERITIES.WARN,
      text: 'rate limit exceeded',
      meta: { kind: 'alert', key: windowKey, limit: max, windowMs },
    });
    return false;
  }

  return {
    checkRateLimit,
    async audit(entry: AuditEvent): Promise<void> {
      try {
        await audit.record(entry);
      } catch (error) {
        // audit is best-effort; a failing sink must never break the tool call
        console.error('mcp audit failed:', error instanceof Error ? error.message : String(error));
      }
    },
    notify: notifications,
    dispose() {
      limiter.clear();
    },
  };
}

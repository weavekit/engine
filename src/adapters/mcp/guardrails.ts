import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { NOOP_AUDIT_SINK } from '../../core/audit/index.js';
import type { AlertSink, AlertLevel } from '../../core/provider/alerts/index.js';
import { ALERT_LEVELS } from '../../core/provider/alerts/index.js';
import { createSlidingWindow, type SlidingWindow } from '../../core/limiter/index.js';

/**
 * Guardrails for the MCP endpoint: per-key sliding-window rate limiting plus
 * injected alert/audit sinks. RBAC is NOT implemented here — it is enforced by
 * the RBAC-decorated data-access layer at call time (see tools.ts).
 *
 * Adapter purity: this module depends on core contracts only. The real sinks
 * (createAlerts() / the audit buffered sink) are injected by the assembly
 * layer (createEngine), keeping the adapters→subsystems dependency ban intact.
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
   * limit. On over-limit it fires a WARN alert and returns false — the caller
   * turns that into an isError tool result. An optional `scope` widens the
   * window key (e.g. `${rolesHash}:${tool}`) so role/tool dimensions get their
   * own windows (M10 D6); scope absent = per-agentKey as before.
   */
  checkRateLimit(key: string, scope?: string, now?: number): boolean;
  /** record a tool-call audit event; failures are caught (audit is best-effort) */
  audit(entry: AuditEvent): Promise<void>;
  /** alert sink for guardrail events (default console) */
  alert: AlertSink;
  /** release timers/state (no-op in the in-memory implementation) */
  dispose(): void;
}

/** minimal console sink so the adapter needs no infrastructure import */
const consoleSink: AlertSink = {
  alert(level: AlertLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    const line = `[weavekit:mcp] ${level}: ${message}${meta !== undefined ? ` ${JSON.stringify(meta)}` : ''}`;
    if (level === ALERT_LEVELS.ERROR) console.error(line);
    else console.warn(line);
    return Promise.resolve();
  },
};

export function createGuardrails(options: {
  rateLimit?: RateLimitConfig;
  alerts?: AlertSink;
  audit?: AuditSink;
}): McpGuardrails {
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const max = options.rateLimit?.max ?? 100;
  const alerts = options.alerts ?? consoleSink;
  const audit = options.audit ?? NOOP_AUDIT_SINK;

  const limiter: SlidingWindow = createSlidingWindow({ windowMs, max });

  function checkRateLimit(key: string, scope?: string, now: number = Date.now()): boolean {
    const windowKey = scope !== undefined ? `${key}:${scope}` : key;
    if (limiter.check(windowKey, now)) return true;
    void alerts.alert(ALERT_LEVELS.WARN, 'rate limit exceeded', { key: windowKey, limit: max, windowMs });
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
    alert: alerts,
    dispose() {
      limiter.clear();
    },
  };
}

import type { AuditSink } from '../../audit/types.js';
import type { Locale } from '../../i18n/index.js';

/**
 * Inbound external-event contract — the ingress seam. Pure interfaces, zero
 * dependencies. The engine provides the mechanism (HTTP entry point, raw-body
 * preservation, rate limiting, audit); the application provides the semantics
 * (provider signature verification + what to do with the event). The engine
 * ships **no** provider-specific mapping — that is exactly the layer that must
 * stay with the integration, not in core.
 */

/** a verified external event, normalized by an {@link IngressVerifier} */
export interface InboundEvent {
  /** provider/source id (the `:source` path segment) */
  source: string;
  /** provider-defined event type, e.g. `invoice.paid` */
  type: string;
  /** provider event id (the app uses it for idempotency), when present */
  id?: string;
  /** when the provider produced the event, when known */
  ts?: Date;
  /** provider payload, passed through untouched */
  payload: unknown;
}

/** the raw request handed to the verifier — signature checks must use `rawBody` */
export interface IngressRequest {
  source: string;
  headers: Record<string, string | string[] | undefined>;
  /** the exact request body string (never a re-serialization) */
  rawBody: string;
}

/**
 * Verify + normalize an inbound request. Return the event on success, or `null`
 * to reject (→ 401). Implementations own provider auth (HMAC, shared token, …);
 * the engine never validates provider secrets.
 */
export type IngressVerifier = (request: IngressRequest) => InboundEvent | null | Promise<InboundEvent | null>;

/** runtime services handed to the handler */
export interface IngressContext {
  /** audit sink — the adapter records the receipt (`ingress.<source>`) itself */
  audit: AuditSink;
  locale: Locale;
}

/** handle a verified inbound event; mapping/routing is entirely the app's job */
export type IngressHandler = (event: InboundEvent, context: IngressContext) => void | Promise<void>;

/**
 * Ingress adapter configuration. Disabled when `config.ingress` is absent.
 * `verifier` + `handler` are required — an unauthenticated ingress is never
 * registered (fail-closed).
 */
export interface IngressConfig {
  /** URL prefix; defaults to `/api` */
  prefix?: string;
  /** per-source sliding-window limiter; disabled when absent */
  rateLimit?: { windowMs?: number; max?: number };
  verifier: IngressVerifier;
  handler: IngressHandler;
}

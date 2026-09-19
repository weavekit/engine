import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUDIT_ACTOR_TYPES, SchemaError } from '../../core/index.js';
import type { AuditSink, Locale } from '../../core/index.js';
import type { IngressConfig } from '../../core/provider/event/index.js';
import type { SlidingWindow } from '../../core/limiter/index.js';

/**
 * Inbound external-event entry point (first-class ingress seam):
 *   POST {prefix}/ingress/:source
 *
 * The raw body is preserved for signature verification, then handed to the
 * application-supplied `verifier`; `null` rejects (401, fail-closed). A verified
 * event goes to the application `handler` and its receipt is written to the
 * audit stream (`ingress.<source>`). The engine maps nothing — provider
 * semantics live with the app.
 */

/** raw bodies keyed by request (populated by the content-type parser below) */
const rawBodies = new WeakMap<FastifyRequest, string>();

export interface IngressDeps {
  /** audit sink (NOOP when audit is disabled) */
  audit: AuditSink;
  locale: Locale;
  /** per-source limiter, created by the assembly layer from `config.rateLimit` */
  rateLimiter?: SlidingWindow;
}

export function registerIngressRoutes(app: FastifyInstance, deps: IngressDeps, config: IngressConfig): void {
  const prefix = config.prefix ?? '/api';

  // keep the exact body bytes for signature verification while still parsing
  // JSON for the parsed `request.body`
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const text = (body as Buffer).toString('utf8');
    rawBodies.set(request, text);
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error);
    }
  });

  app.post(`${prefix}/ingress/:source`, async (request, reply) => {
    const { source } = request.params as { source: string };

    if (deps.rateLimiter !== undefined && !deps.rateLimiter.check(source)) {
      throw new SchemaError('http.rateLimited', {}, deps.locale);
    }

    const rawBody =
      rawBodies.get(request) ?? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {}));

    const event = await config.verifier({ source, headers: request.headers, rawBody });
    if (event === null) throw new SchemaError('ingress.unauthorized', { source }, deps.locale);

    await config.handler(event, { audit: deps.audit, locale: deps.locale });

    void deps.audit.record({
      actorType: AUDIT_ACTOR_TYPES.SYSTEM,
      actorId: source,
      action: `ingress.${source}`,
      changes: { type: event.type, id: event.id },
      meta: { source, ingressType: event.type, ingressId: event.id },
      timestamp: new Date(),
    });

    reply.code(202).send({ accepted: true });
  });
}

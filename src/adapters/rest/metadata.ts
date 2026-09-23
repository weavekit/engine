import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describeObject, listObjectDescriptors } from '../../core/object/describe.js';
import type { RestDeps, RestOptions } from './plugin.js';
import { authenticateRequest, checkRateLimit, readString } from './common.js';

/**
 * Metadata route (framework-agnostic): neutral schema + permissions for
 * frontend adapters (Refine Inferencer / react-admin auto-forms).
 *   GET {prefix}/metadata            → { objects: [ObjectDescriptor] } (readable only)
 *   GET {prefix}/metadata?object=X   → one ObjectDescriptor (404 unknown, 403 unreadable)
 * Responses carry an ETag so frontends can cache/invalidate per schema hash.
 */
export function registerMetadataRoutes(app: FastifyInstance, deps: RestDeps, options: RestOptions = {}): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/metadata`, async (request, reply) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const object = readString(request.query as Record<string, unknown>, 'object', locale);
    const result =
      object === undefined
        ? {
            objects: listObjectDescriptors(registry, subject.roles).map((o) =>
              describeObject(registry, o.name, subject.roles, locale),
            ),
          }
        : describeObject(registry, object, subject.roles, locale);
    const etag = `"${createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 32)}"`;
    reply.header('etag', etag);
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    return result;
  });
}

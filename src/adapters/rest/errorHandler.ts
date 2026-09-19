import type { FastifyInstance } from 'fastify';
import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import { mapSchemaError } from '../../core/api/index.js';

/**
 * Install uniform error handling on the app:
 * - setErrorHandler: every thrown error → {@link mapSchemaError} spec
 * - setNotFoundHandler: unknown routes → uniform 404 body
 */
export function setErrorHandlers(app: FastifyInstance, locale: Locale): void {
  app.setErrorHandler((err, _request, reply) => {
    const spec = mapSchemaError(err, locale);
    reply.status(spec.status).send(spec.body);
  });
  app.setNotFoundHandler((_request, reply) => {
    const spec = mapSchemaError(new SchemaError('http.notFound', {}, locale), locale);
    reply.status(spec.status).send(spec.body);
  });
}

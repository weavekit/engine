import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import { mapSchemaError } from '../../core/api/index.js';

export interface ErrorHandlerOptions {
  /** add a `WWW-Authenticate` challenge to 401 responses (RFC 9728 OAuth protected-resource) */
  wwwAuthenticate?: (request: FastifyRequest) => string;
}

/**
 * Install uniform error handling on the app:
 * - setErrorHandler: every thrown error → {@link mapSchemaError} spec
 * - setNotFoundHandler: unknown routes → uniform 404 body
 */
export function setErrorHandlers(app: FastifyInstance, locale: Locale, options: ErrorHandlerOptions = {}): void {
  app.setErrorHandler((err, request, reply) => {
    const spec = mapSchemaError(err, locale);
    if (spec.status === 401 && options.wwwAuthenticate !== undefined) {
      reply.header('WWW-Authenticate', options.wwwAuthenticate(request));
    }
    reply.status(spec.status).send(spec.body);
  });
  app.setNotFoundHandler((_request, reply) => {
    const spec = mapSchemaError(new SchemaError('http.notFound', {}, locale), locale);
    reply.status(spec.status).send(spec.body);
  });
}

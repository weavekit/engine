import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Locale } from '../../core/index.js';
import { negotiateLocale, SchemaError } from '../../core/index.js';
import { mapSchemaError } from '../../core/api/index.js';

function requestLocale(request: FastifyRequest, fallback: Locale): Locale {
  return negotiateLocale(request.headers['accept-language'], fallback);
}

function addAcceptLanguageVary(reply: FastifyReply): void {
  const current = reply.getHeader('vary');
  const values = Array.isArray(current) ? current.map(String) : current === undefined ? [] : [String(current)];
  const parts = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (!parts.some((value) => value.toLowerCase() === 'accept-language')) parts.push('Accept-Language');
  reply.header('Vary', parts.join(', '));
}

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
    const resolvedLocale = requestLocale(request, locale);
    const spec = mapSchemaError(err, resolvedLocale);
    addAcceptLanguageVary(reply);
    if (spec.status === 401 && options.wwwAuthenticate !== undefined) {
      reply.header('WWW-Authenticate', options.wwwAuthenticate(request));
    }
    reply.status(spec.status).send(spec.body);
  });
  app.setNotFoundHandler((request, reply) => {
    const resolvedLocale = requestLocale(request, locale);
    const spec = mapSchemaError(new SchemaError('http.notFound', {}, resolvedLocale), resolvedLocale);
    addAcceptLanguageVary(reply);
    reply.status(spec.status).send(spec.body);
  });
}

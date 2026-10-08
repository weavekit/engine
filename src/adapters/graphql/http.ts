import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { execute, GraphQLError, parse, validate, type GraphQLSchema } from 'graphql';
import { createSlidingWindow, SchemaError, type IdentitySubject, type Locale } from '../../core/index.js';
import { mapSchemaError } from '../../core/api/index.js';
import { authenticate, type Authenticator } from '../auth/index.js';
import { createRecordLoader } from './loader.js';
import { resolveSecurity, validateQuery, validationRules } from './security.js';
import type { EngineGraphQLConfig, GraphQLEngine } from './types.js';

/**
 * Fastify adapter for the GraphQL endpoint (`/graphql`, POST + GET).
 *
 * A thin, dependency-light HTTP handler (per the plan's decision 1B): the engine
 * ships `graphql` as its only new runtime dependency and speaks GraphQL-over-HTTP
 * itself. Request order: authenticate (plain `401`) → rate limit → parse →
 * validate → query hardening (depth/complexity/alias) → execute. GraphQL-level
 * problems (parse/validate/execute) return `200 { errors }`; a rejected security
 * limit carries its stable code in `errors[].extensions.code`.
 */

export interface GraphQLRouteDeps {
  engine: GraphQLEngine;
  authenticator: Authenticator;
  schema: GraphQLSchema;
  graphql: EngineGraphQLConfig | undefined;
  locale: Locale;
}

/** uniform error body (matches the REST/MCP contract) */
function errorBody(code: string, message: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { error: { code, message, ...(params === undefined ? {} : { params }) } };
}

function formatError(error: GraphQLError): Record<string, unknown> {
  return {
    message: error.message,
    ...(error.locations === undefined ? {} : { locations: error.locations }),
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.extensions === undefined || Object.keys(error.extensions).length === 0
      ? {}
      : { extensions: error.extensions }),
  };
}

interface ParsedOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function badRequest(detail: string, param: string): Record<string, unknown> {
  return errorBody('http.param.invalid', detail, { param });
}

/** parse a POST (JSON body) or GET (query string) request into a GraphQL operation */
function parseOperation(request: FastifyRequest): ParsedOperation | Record<string, unknown> {
  if (request.method === 'GET') {
    const q = request.query as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof q.query !== 'string' || q.query.length === 0) return badRequest('query is required', 'query');
    let variables: Record<string, unknown> | undefined;
    if (typeof q.variables === 'string' && q.variables.length > 0) {
      try {
        variables = JSON.parse(q.variables) as Record<string, unknown>;
      } catch {
        return badRequest('variables must be valid JSON', 'variables');
      }
    }
    const operationName = typeof q.operationName === 'string' && q.operationName.length > 0 ? q.operationName : undefined;
    return {
      query: q.query,
      ...(variables === undefined ? {} : { variables }),
      ...(operationName === undefined ? {} : { operationName }),
    };
  }

  const body = request.body as { query?: unknown; variables?: unknown; operationName?: unknown } | undefined;
  if (body === undefined || typeof body !== 'object' || body === null) {
    return badRequest('request body must be a JSON object', 'body');
  }
  if (typeof body.query !== 'string' || body.query.length === 0) return badRequest('query is required', 'query');
  let variables: Record<string, unknown> | undefined;
  if (body.variables !== undefined) {
    if (typeof body.variables !== 'object' || body.variables === null || Array.isArray(body.variables)) {
      return badRequest('variables must be an object', 'variables');
    }
    variables = body.variables as Record<string, unknown>;
  }
  const operationName = typeof body.operationName === 'string' && body.operationName.length > 0 ? body.operationName : undefined;
  return {
    query: body.query,
    ...(variables === undefined ? {} : { variables }),
    ...(operationName === undefined ? {} : { operationName }),
  };
}

function isParsed(value: ParsedOperation | Record<string, unknown>): value is ParsedOperation {
  return typeof (value as ParsedOperation).query === 'string';
}

export function registerGraphQLRoutes(app: FastifyInstance, deps: GraphQLRouteDeps): void {
  const path = deps.graphql?.prefix ?? '/graphql';
  const limiter = deps.graphql?.rateLimit === undefined ? undefined : createSlidingWindow(deps.graphql.rateLimit);
  const security = resolveSecurity(deps.graphql?.security);

  app.route({
    method: ['POST', 'GET'],
    url: path,
    handler: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // authenticate before executing (401 stays a plain HTTP error)
      let subject: IdentitySubject;
      try {
        subject = await authenticate(deps.authenticator, request.headers.authorization, deps.locale);
      } catch (error) {
        const spec = mapSchemaError(error, deps.locale);
        reply.status(spec.status).send(spec.body);
        return;
      }

      if (limiter !== undefined) {
        const auth = request.headers.authorization;
        const key = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : subject.id;
        if (!limiter.check(key)) {
          reply.status(429).send(errorBody('http.rateLimited', 'rate limit exceeded'));
          return;
        }
      }

      const parsed = parseOperation(request);
      if (!isParsed(parsed)) {
        reply.status(400).send(parsed);
        return;
      }

      // parse → validate → harden → execute (all GraphQL-level failures are 200)
      let document;
      try {
        document = parse(parsed.query);
      } catch (error) {
        reply.status(200).send({ errors: [formatError(error as GraphQLError)] });
        return;
      }

      const validationErrors = validate(deps.schema, document, validationRules(security));
      if (validationErrors.length > 0) {
        reply.status(200).send({ errors: validationErrors.map(formatError) });
        return;
      }

      try {
        validateQuery(document, security, deps.locale);
      } catch (error) {
        if (error instanceof SchemaError) {
          reply.status(200).send({
            errors: [
              {
                message: error.localize(deps.locale),
                extensions: { code: error.code, ...(Object.keys(error.params).length === 0 ? {} : { params: error.params }) },
              },
            ],
          });
          return;
        }
        throw error;
      }

      const result = await execute({
        schema: deps.schema,
        document,
        ...(parsed.variables === undefined ? {} : { variableValues: parsed.variables }),
        ...(parsed.operationName === undefined ? {} : { operationName: parsed.operationName }),
        contextValue: { subject, engine: deps.engine, loader: createRecordLoader(deps.engine, subject), requestId: request.id },
      });

      const body: Record<string, unknown> = {};
      if (result.data !== undefined) body.data = result.data;
      if (result.errors !== undefined) body.errors = result.errors.map(formatError);
      reply.status(200).send(body);
    },
  });
}

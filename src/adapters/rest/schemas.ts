import type { FastifyInstance } from 'fastify';
import { SchemaError, type Locale, type ObjectRegistry } from '../../core/index.js';
import type { AutoCommitOptions } from '../../runtime/git/index.js';
import { readSchemaSource, writeSchemaSource } from '../../runtime/git/schemaSource.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

/** raw schema source routes: admin-only GET/PUT `{source, version}` */
export interface SchemaRouteDeps {
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
  projectDir?: string;
  commitIdentity?: AutoCommitOptions['identity'];
}

function schemaBody(
  body: unknown,
  locale: Locale,
): { source: string; expectVersion?: string; force?: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SchemaError('http.param.invalid', { param: 'body' }, locale);
  }
  const { source, expectVersion, force } = body as Record<string, unknown>;
  if (typeof source !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'source' }, locale);
  }
  if (expectVersion !== undefined && typeof expectVersion !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'expectVersion' }, locale);
  }
  if (force !== undefined && typeof force !== 'boolean') {
    throw new SchemaError('http.param.invalid', { param: 'force' }, locale);
  }
  return { source, expectVersion, force };
}

export function registerSchemaRoutes(
  app: FastifyInstance,
  deps: SchemaRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/objects/:name/schema`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, name, options.adminRoles, locale);
    if (deps.projectDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const document = await readSchemaSource(deps.projectDir, name);
    if (document === null) throw new SchemaError('http.notFound', {}, locale);
    return document;
  });

  app.put(`${prefix}/objects/:name/schema`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, name, options.adminRoles, locale);
    if (deps.projectDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const body = schemaBody(request.body, locale);
    const result = await writeSchemaSource({
      projectDir: deps.projectDir,
      registry,
      name,
      source: body.source,
      expectVersion: body.expectVersion,
      force: body.force,
      identity: deps.commitIdentity,
      locale,
    });
    return { ok: true, committed: result.committed, version: result.version };
  });
}

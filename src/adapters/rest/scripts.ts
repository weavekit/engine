import type { FastifyInstance } from 'fastify';
import {
  SCRIPT_SOURCE_KINDS,
  SchemaError,
  type Locale,
  type ObjectRegistry,
  type ScriptSourceKind,
} from '../../core/index.js';
import type { AutoCommitOptions } from '../../runtime/git/index.js';
import { readScriptSource, writeScriptSource } from '../../runtime/git/scriptSource.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

export interface ScriptRouteDeps {
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
  projectDir?: string;
  commitIdentity?: AutoCommitOptions['identity'];
}

function scriptKind(value: string, locale: Locale): ScriptSourceKind {
  if (!Object.values(SCRIPT_SOURCE_KINDS).includes(value as ScriptSourceKind)) {
    throw new SchemaError('http.param.invalid', { param: 'kind' }, locale);
  }
  return value as ScriptSourceKind;
}

function saveBody(body: unknown, locale: Locale): { source: string; expectVersion?: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SchemaError('http.param.invalid', { param: 'body' }, locale);
  }
  const { source, expectVersion } = body as Record<string, unknown>;
  if (typeof source !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'source' }, locale);
  }
  if (expectVersion !== undefined && typeof expectVersion !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'expectVersion' }, locale);
  }
  return expectVersion === undefined ? { source } : { source, expectVersion };
}

export function registerScriptRoutes(
  app: FastifyInstance,
  deps: ScriptRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/objects/:name/scripts/:kind`, async (request) => {
    const { name, kind: rawKind } = request.params as { name: string; kind: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    const kind = scriptKind(rawKind, locale);
    if (kind === SCRIPT_SOURCE_KINDS.SERVER) {
      requireAdmin(subject.roles, name, options.adminRoles, locale);
    }
    if (deps.projectDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const document = await readScriptSource(deps.projectDir, registry, name, kind);
    if (document === null) throw new SchemaError('http.notFound', {}, locale);
    return document;
  });

  app.put(`${prefix}/objects/:name/scripts/:kind`, async (request) => {
    const { name, kind: rawKind } = request.params as { name: string; kind: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, name, options.adminRoles, locale);
    const kind = scriptKind(rawKind, locale);
    const body = saveBody(request.body, locale);
    if (deps.projectDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const result = await writeScriptSource({
      projectDir: deps.projectDir,
      registry,
      objectName: name,
      kind,
      source: body.source,
      identity: deps.commitIdentity,
      locale,
    });
    return { ok: true, committed: result.committed, version: result.version };
  });
}
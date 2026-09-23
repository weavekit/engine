import type { FastifyInstance } from 'fastify';
import { SchemaError, type Locale } from '../../core/index.js';
import type { AutoCommitOptions } from '../../runtime/git/index.js';
import {
  listGuardrailHistory,
  listGuardrailPolicies,
  readGuardrailPolicy,
  writeGuardrailPolicy,
} from '../../runtime/git/guardrailSource.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

export interface GuardrailsRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  projectDir?: string;
  /** resolved guardrail policies directory (relative to projectDir); absent = guardrails disabled */
  policiesDir?: string;
  commitIdentity?: AutoCommitOptions['identity'];
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

/**
 * Guardrail policy source routes (admin): list the engine project's
 * `policies/` directory, read a policy's source, and write it back (git
 * committed). Only the directory configured via `tools.guardrails.policies`
 * (a string) is exposed — inline-array guardrails have no file surface.
 * Enabled only when the engine project supplies a policies directory.
 */
export function registerGuardrailsRoutes(
  app: FastifyInstance,
  deps: GuardrailsRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/guardrails/policies`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'guardrails', options.adminRoles, locale);
    if (deps.projectDir === undefined || deps.policiesDir === undefined) return { policies: [] };
    const policies = await listGuardrailPolicies(deps.projectDir, deps.policiesDir);
    return { policies };
  });

  app.get(`${prefix}/guardrails/policies/:name`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'guardrails', options.adminRoles, locale);
    if (deps.projectDir === undefined || deps.policiesDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const document = await readGuardrailPolicy(deps.projectDir, deps.policiesDir, name);
    if (document === null) throw new SchemaError('http.notFound', {}, locale);
    return document;
  });

  app.get(`${prefix}/guardrails/policies/:name/history`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'guardrails', options.adminRoles, locale);
    if (deps.projectDir === undefined || deps.policiesDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    return await listGuardrailHistory(deps.projectDir, deps.policiesDir, name);
  });

  app.put(`${prefix}/guardrails/policies/:name`, async (request) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'guardrails', options.adminRoles, locale);
    if (deps.projectDir === undefined || deps.policiesDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    const body = saveBody(request.body, locale);
    const result = await writeGuardrailPolicy(deps.projectDir, deps.policiesDir, name, {
      source: body.source,
      identity: deps.commitIdentity,
      locale,
    });
    return { ok: true, committed: result.committed, version: result.version };
  });
}

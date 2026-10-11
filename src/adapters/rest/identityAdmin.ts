import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { Authenticator } from '../auth/index.js';
import type { IdentityAdmin } from '../../runtime/identity/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

export interface IdentityAdminRouteDeps {
  authenticator: Authenticator;
  locale: Locale;
  admin: IdentityAdmin;
}

/** string array from a body value (array, or a comma-separated string) */
function parseRoles(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v !== '');
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** nullable string from a body value */
function optString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}

/**
 * Greenfield identity administration (admin-gated, `adapters.rest.adminRoles`):
 *   GET    {prefix}/identity/users        → { users: [{ id, name, email, mobile, roles, departmentId, enabled }] }
 *   POST   {prefix}/identity/users        → { id } (create an engine-owned user)
 *   PATCH  {prefix}/identity/users/:id    → { id, enabled?, roles? } (enable/disable and/or set roles)
 *   DELETE {prefix}/identity/users/:id    → 204
 *   GET    {prefix}/identity/departments  → { departments: [...] }
 *   POST   {prefix}/identity/departments  → { id } (create an engine-owned department)
 */
export function registerIdentityAdminRoutes(
  app: FastifyInstance,
  deps: IdentityAdminRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { authenticator, locale, admin } = deps;
  const limiter = options.rateLimiter;

  const gate = async (request: FastifyRequest): Promise<void> => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'identity', options.adminRoles, locale);
  };

  const notFound = (id: string): SchemaError => new SchemaError('data.recordNotFound', { object: 'weavekit_user', id }, locale);

  app.get(`${prefix}/identity/users`, async (request) => {
    await gate(request);
    return { users: await admin.list() };
  });

  app.post(`${prefix}/identity/users`, async (request, reply) => {
    await gate(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { id } = await admin.create({
      name: body.name === undefined ? null : String(body.name),
      email: body.email === undefined ? null : String(body.email),
      mobile: body.mobile === undefined ? null : String(body.mobile),
      roles: parseRoles(body.roles),
      enabled: body.enabled === undefined ? true : body.enabled === true,
    });
    return reply.code(201).send({ id });
  });

  app.patch(`${prefix}/identity/users/:id`, async (request) => {
    await gate(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hasEnabled = body.enabled !== undefined;
    const hasRoles = body.roles !== undefined;
    if (!hasEnabled && !hasRoles) {
      throw new SchemaError('http.param.invalid', { param: 'enabled|roles' }, locale);
    }
    if (hasEnabled) {
      if (typeof body.enabled !== 'boolean') throw new SchemaError('http.param.invalid', { param: 'enabled' }, locale);
      if (!(await admin.setEnabled(id, body.enabled))) throw notFound(id);
    }
    if (hasRoles) {
      if (!(await admin.setRoles(id, parseRoles(body.roles) ?? []))) throw notFound(id);
    }
    return { id };
  });

  app.delete(`${prefix}/identity/users/:id`, async (request, reply) => {
    await gate(request);
    const { id } = request.params as { id: string };
    if (!(await admin.remove(id))) throw notFound(id);
    reply.code(204).send();
  });

  app.get(`${prefix}/identity/departments`, async (request) => {
    await gate(request);
    return { departments: await admin.listDepartments() };
  });

  app.post(`${prefix}/identity/departments`, async (request, reply) => {
    await gate(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { id } = await admin.createDepartment({
      name: optString(body.name) ?? null,
      code: optString(body.code) ?? null,
      parentId: optString(body.parentId) ?? null,
      managerId: optString(body.managerId) ?? null,
      enabled: body.enabled === undefined ? true : body.enabled === true,
    });
    return reply.code(201).send({ id });
  });
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SchemaError, WORKFLOW_FORMAT_VERSION, type Locale, type ObjectRegistry } from '../../core/index.js';
import type { AutoCommitOptions } from '../../runtime/git/index.js';
import { readWorkflowSource, writeWorkflowSource } from '../../runtime/git/workflowSource.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

/** workflow definition source routes: admin-only GET/PUT `objects/<name>/workflow.json` */
export interface WorkflowSourceRouteDeps {
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
  projectDir?: string;
  commitIdentity?: AutoCommitOptions['identity'];
}

/** accept `{ source }` (raw workflow.json) or `{ nodes, version? }` (built) */
function specBody(body: unknown, locale: Locale): { source: string; expectVersion?: string; force?: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SchemaError('http.param.invalid', { param: 'body' }, locale);
  }
  const { source, nodes, version, expectVersion, force } = body as Record<string, unknown>;
  let text: string;
  if (typeof source === 'string') {
    text = source;
  } else if (Array.isArray(nodes)) {
    text = `${JSON.stringify(
      { schemaVersion: WORKFLOW_FORMAT_VERSION, ...(typeof version === 'number' ? { version } : {}), nodes },
      null,
      2,
    )}\n`;
  } else {
    throw new SchemaError('http.param.invalid', { param: 'source' }, locale);
  }
  return {
    source: text,
    ...(typeof expectVersion === 'string' ? { expectVersion } : {}),
    ...(typeof force === 'boolean' ? { force } : {}),
  };
}

export function registerWorkflowSourceRoutes(
  app: FastifyInstance,
  deps: WorkflowSourceRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  app.get(`${prefix}/objects/:name/workflow/spec`, async (request: FastifyRequest) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, name, options.adminRoles, locale);
    if (deps.projectDir === undefined) throw new SchemaError('http.notFound', {}, locale);
    const document = await readWorkflowSource(deps.projectDir, name);
    if (document === null) throw new SchemaError('http.notFound', {}, locale);
    return document;
  });

  app.put(`${prefix}/objects/:name/workflow/spec`, async (request: FastifyRequest) => {
    const { name } = request.params as { name: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, name, options.adminRoles, locale);
    if (deps.projectDir === undefined) throw new SchemaError('http.notFound', {}, locale);
    const body = specBody(request.body, locale);
    const result = await writeWorkflowSource({
      projectDir: deps.projectDir,
      registry,
      name,
      source: body.source,
      expectVersion: body.expectVersion,
      force: body.force,
      identity: deps.commitIdentity,
      locale,
    });
    return { ok: true, committed: result.committed, version: result.version, hash: result.hash };
  });
}

import type { FastifyInstance } from 'fastify';
import { SchemaError, type Locale, type ObjectRegistry } from '../../core/index.js';
import {
  OBJECT_LAYOUT_VIEWS,
  layoutPagePath,
  parseLayoutPagePath,
  type LayoutAddress,
} from '../../layout-format.js';
import type { AutoCommitOptions, SourceFileCandidate } from '../../runtime/git/index.js';
import {
  layoutPathOf,
  readLayoutSource,
  validateLayoutCandidate,
  writeLayoutSource,
} from '../../runtime/git/layoutSource.js';
import {
  deletePageScript,
  isPageScriptKind,
  pageFaceScriptRelPath,
  parsePageFaceScope,
  readPageScript,
  writePageScript,
  type PageScriptKind,
} from '../../runtime/git/pageScripts.js';
import {
  schemaPathOf,
  validateSchemaCandidate,
} from '../../runtime/git/schemaSource.js';
import {
  createCustomPage,
  deleteCustomPage,
  listPages,
  renameCustomPage,
} from '../../runtime/git/pageCatalog.js';
import { deleteSourceFile, runSourceTransaction } from '../../runtime/git/sourceTransaction.js';
import type { Authenticator } from '../auth/index.js';
import { authenticateRequest, checkRateLimit, requireAdmin } from './common.js';
import type { RestOptions } from './plugin.js';

/** page routes: path-mirrored layout source + custom-page lifecycle */
export interface PagesRouteDeps {
  registry: ObjectRegistry;
  authenticator: Authenticator;
  locale: Locale;
  projectDir?: string;
  commitIdentity?: AutoCommitOptions['identity'];
}

interface SourcePart {
  source: string;
  expectVersion?: string;
}

/** page-scoped client script dispatch — `/pages/<page>/objects/<object>/scripts/<kind>` (page × object face). Client-only. */
type ScriptDispatch = { scope: 'page-face'; page: string; object: string; kind: PageScriptKind } | null;

function parseScriptPath(path: string): ScriptDispatch {
  const match = /^(.*)\/scripts\/([^/]+)$/.exec(path);
  if (match === null || !isPageScriptKind(match[2]!)) return null;
  const face = parsePageFaceScope(match[1]!);
  return face === undefined ? null : { scope: 'page-face', page: face.page, object: face.object, kind: match[2] };
}

function scriptRelPath(script: NonNullable<ScriptDispatch>): string {
  return pageFaceScriptRelPath(script.page, script.object, script.kind);
}

function sourcePart(body: unknown, locale: Locale): { source: string; expectVersion?: string; force?: boolean } {
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

function parsePart(value: unknown, locale: Locale): SourcePart {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaError('http.param.invalid', { param: 'body' }, locale);
  }
  const { source, expectVersion } = value as Record<string, unknown>;
  if (typeof source !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'source' }, locale);
  }
  if (expectVersion !== undefined && typeof expectVersion !== 'string') {
    throw new SchemaError('http.param.invalid', { param: 'expectVersion' }, locale);
  }
  return expectVersion === undefined ? { source } : { source, expectVersion };
}

export function registerPagesRoutes(
  app: FastifyInstance,
  deps: PagesRouteDeps,
  options: RestOptions = {},
): void {
  const prefix = options.prefix ?? '/api';
  const { registry, authenticator, locale } = deps;
  const limiter = options.rateLimiter;

  function requireProject(): string {
    if (deps.projectDir === undefined) {
      throw new SchemaError('http.notFound', {}, locale);
    }
    return deps.projectDir;
  }

  function resolveAddr(request: { params: unknown }): LayoutAddress {
    const path = (request.params as Record<string, unknown>)['*'];
    if (typeof path !== 'string') {
      throw new SchemaError('http.param.invalid', { param: 'path' }, locale);
    }
    const addr = parseLayoutPagePath(path);
    if (addr === undefined) {
      throw new SchemaError('http.param.invalid', { param: 'path' }, locale);
    }
    if (addr.kind === 'object') {
      // object page — the id must be a registry object
      if (registry.get(addr.id) === undefined) {
        throw new SchemaError('http.notFound', {}, locale);
      }
    }
    if (addr.kind === 'page-face') {
      // page × object face — the object must exist (the page is a custom page dir)
      if (registry.get(addr.object) === undefined) {
        throw new SchemaError('http.notFound', {}, locale);
      }
    }
    return addr;
  }

  // catalog (authenticated)
  app.get(`${prefix}/pages`, async (request) => {
    checkRateLimit(limiter, request, locale);
    await authenticateRequest(authenticator, request, locale);
    return listPages(requireProject(), registry);
  });

  // create custom page (admin)
  app.post(`${prefix}/pages`, async (request) => {
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    const projectDir = requireProject();
    const body = request.body as Record<string, unknown>;
    const id = body.id;
    if (typeof id !== 'string' || id === '') {
      throw new SchemaError('http.param.invalid', { param: 'id' }, locale);
    }
    const source = typeof body.source === 'string' ? body.source : undefined;
    const result = await createCustomPage({ projectDir, registry, id, source, identity: deps.commitIdentity, locale });
    return { ok: true, id, path: result.path };
  });

  // read layout source / page script (authenticated)
  app.get(`${prefix}/pages/*`, async (request) => {
    const path = (request.params as Record<string, unknown>)['*'] as string;
    const script = parseScriptPath(path);
    checkRateLimit(limiter, request, locale);
    await authenticateRequest(authenticator, request, locale);
    const projectDir = requireProject();
    if (script !== null) {
      const document = await readPageScript(projectDir, scriptRelPath(script));
      if (document === null) throw new SchemaError('http.notFound', {}, locale);
      return document;
    }
    const addr = resolveAddr(request);
    const document = await readLayoutSource(projectDir, addr);
    if (document === null) throw new SchemaError('http.notFound', {}, locale);
    return document;
  });

  // write layout source / page script (admin)
  app.put(`${prefix}/pages/*`, async (request) => {
    const path = (request.params as Record<string, unknown>)['*'] as string;
    const script = parseScriptPath(path);
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    if (script !== null) {
      const body = sourcePart(request.body, locale);
      const result = await writePageScript({
        projectDir: requireProject(),
        relPath: scriptRelPath(script),
        source: body.source,
        identity: deps.commitIdentity,
        locale,
      });
      return { ok: true, committed: result.committed, version: result.version };
    }
    const addr = resolveAddr(request);
    const body = sourcePart(request.body, locale);
    const result = await writeLayoutSource({
      projectDir: requireProject(),
      addr,
      source: body.source,
      expectVersion: body.expectVersion,
      force: body.force,
      registry,
      identity: deps.commitIdentity,
      locale,
    });
    return { ok: true, committed: result.committed, version: result.version };
  });

  // delete a page-scoped face (script or layout) — falling back to the object canonical (admin)
  app.delete(`${prefix}/pages/*`, async (request) => {
    const path = (request.params as Record<string, unknown>)['*'] as string;
    const script = parseScriptPath(path);
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    const projectDir = requireProject();
    if (script !== null) {
      const result = await deletePageScript(projectDir, scriptRelPath(script), deps.commitIdentity, locale);
      return { ok: true, deleted: result.deleted };
    }
    const addr = resolveAddr(request);
    if (addr.kind !== 'page-face') throw new SchemaError('http.notFound', {}, locale);
    const result = await deleteSourceFile({ projectDir, path: layoutPathOf(addr), message: `chore(pages): delete face ${layoutPagePath(addr)}`, identity: deps.commitIdentity, locale });
    return { ok: true, deleted: result.committed };
  });

  // rename custom page (admin)
  app.patch(`${prefix}/pages/:id`, async (request) => {
    const { id } = request.params as { id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    const body = request.body as Record<string, unknown>;
    if (typeof body.newId !== 'string' || body.newId === '') {
      throw new SchemaError('http.param.invalid', { param: 'newId' }, locale);
    }
    const result = await renameCustomPage({ projectDir: requireProject(), id, newId: body.newId, identity: deps.commitIdentity, locale });
    return { ok: true, id: body.newId, path: result.path };
  });

  // delete custom page (admin; ref-protected)
  app.delete(`${prefix}/pages/:id`, async (request) => {
    const { id } = request.params as { id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    const result = await deleteCustomPage({ projectDir: requireProject(), id, identity: deps.commitIdentity, locale });
    return { ok: true, deleted: result.deleted };
  });

  // atomic object design transaction: show + list + schema in one commit (admin)
  app.put(`${prefix}/pages/:id/design`, async (request) => {
    const { id } = request.params as { id: string };
    checkRateLimit(limiter, request, locale);
    const subject = await authenticateRequest(authenticator, request, locale);
    requireAdmin(subject.roles, 'pages', options.adminRoles, locale);
    const projectDir = requireProject();
    if (registry.get(id) === undefined) {
      throw new SchemaError('data.objectUnknown', { object: id }, locale);
    }
    const body = request.body as Record<string, unknown>;
    const files: SourceFileCandidate[] = [];
    const validators: Array<{ path: string; check: (source: string) => void }> = [];

    const pushView = (view: 'show' | 'list', value: unknown): void => {
      const part = parsePart(value, locale);
      const addr: LayoutAddress = { kind: 'object', id, view };
      files.push({ path: layoutPathOf(addr), source: part.source, expectVersion: part.expectVersion });
      validators.push({ path: layoutPathOf(addr), check: (s) => validateLayoutCandidate({ addr, source: s, registry, locale }) });
    };
    if (body.show !== undefined) pushView(OBJECT_LAYOUT_VIEWS.SHOW, body.show);
    if (body.list !== undefined) pushView(OBJECT_LAYOUT_VIEWS.LIST, body.list);
    if (body.schema !== undefined) {
      const part = parsePart(body.schema, locale);
      files.push({ path: schemaPathOf(id), source: part.source, expectVersion: part.expectVersion });
      validators.push({ path: schemaPathOf(id), check: (s) => validateSchemaCandidate({ registry, name: id, source: s, locale }) });
    }
    if (files.length === 0) {
      throw new SchemaError('http.param.invalid', { param: 'body' }, locale);
    }
    const force = typeof body.force === 'boolean' ? body.force : undefined;
    const result = await runSourceTransaction({
      projectDir,
      files,
      force,
      identity: deps.commitIdentity,
      locale,
      message: `chore(design): update ${id}`,
      validate: async (candidate) => {
        const validator = validators.find((v) => v.path === candidate.path);
        if (validator !== undefined) validator.check(candidate.source);
      },
    });
    return { ok: true, committed: result.committed };
  });
}

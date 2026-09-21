import { version } from '../../version.js';
import { SCRIPT_SOURCE_KINDS } from '../../core/index.js';
import {
  OPENAPI_TAGS,
  OPENAPI_TAG_DESCRIPTIONS,
  type BuildOpenApiInput,
  type OpenApiCapabilities,
  type OpenApiDocument,
} from './types.js';
import { objectSchemas } from './schema.js';

type Json = Record<string, unknown>;

/**
 * Structural view of the config used to derive which route groups exist. Kept
 * loose so this module does not depend on the engine runtime assembly.
 */
export interface OpenApiConfigLike {
  schemaDir?: string;
  adapters?: {
    rest?: { enabled?: boolean; prefix?: string };
    events?: { enabled?: boolean; prefix?: string };
    mcp?: { enabled?: boolean; endpoint?: string };
  };
  subsystems?: { audit?: { enabled?: boolean } };
  tools?: { toolsDir?: string; guardrails?: { policies?: unknown } };
  proxy?: { resolver?: unknown };
  ingress?: { prefix?: string };
}

/** derive the capability snapshot the generator documents from. */
export function capabilitiesFromConfig(config: OpenApiConfigLike): OpenApiCapabilities {
  const restPrefix = config.adapters?.rest?.prefix ?? '/api';
  const eventsEnabled = config.adapters?.events?.enabled !== false;
  const mcpEnabled = config.adapters?.mcp?.enabled !== false;
  return {
    prefix: restPrefix,
    events: eventsEnabled ? { prefix: config.adapters?.events?.prefix ?? '/api' } : undefined,
    ingress: config.ingress === undefined ? undefined : { prefix: config.ingress.prefix ?? '/api' },
    audit: config.subsystems?.audit?.enabled === true,
    approvals: config.tools?.toolsDir !== undefined,
    proxy: config.proxy?.resolver !== undefined,
    guardrails: typeof config.tools?.guardrails?.policies === 'string',
    projectDir: config.schemaDir !== undefined,
    mcp: mcpEnabled ? { endpoint: config.adapters?.mcp?.endpoint ?? '/mcp' } : undefined,
  };
}

const ERROR_REF = { $ref: '#/components/responses/Error' };
const RECORD_REF = { $ref: '#/components/schemas/ObjectRecord' };
const LIST_REF = { $ref: '#/components/schemas/ListResult' };
const IDLIST_REF = { $ref: '#/components/schemas/IdList' };
const GENERIC_OBJECT = { type: 'object', additionalProperties: true };

function json(schema: unknown): Json {
  return { content: { 'application/json': { schema } } };
}

function ok(description: string, schema?: unknown): Json {
  return schema === undefined ? { description } : { description, ...json(schema) };
}

function errors(...statuses: string[]): Json {
  const out: Json = { default: ERROR_REF };
  for (const status of statuses) out[status] = ERROR_REF;
  return out;
}

const P = {
  name: { name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: 'Object name from `objects/<name>/schema.json`.' },
  id: { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Record primary key.' },
  limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Page size.' },
  offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Rows to skip.' },
  filter: { name: 'filter', in: 'query', schema: { type: 'string' }, description: 'URL-encoded JSON object of field filters.', example: '{"status":"open"}' },
  sort: { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Comma-separated `field:direction` pairs.', example: 'created_at:desc' },
  fields: { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated field projection.', example: 'id,title' },
  objectQuery: { name: 'object', in: 'query', schema: { type: 'string' }, description: 'Return one object descriptor instead of all.' },
  kind: { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: [SCRIPT_SOURCE_KINDS.SERVER] }, description: 'Script kind.' },
  approvalKey: { name: 'key', in: 'path', required: true, schema: { type: 'string' }, description: 'Deterministic approval key.' },
  policyName: { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
  source: { name: 'source', in: 'path', required: true, schema: { type: 'string' }, description: 'Provider/source identifier.' },
  instance: { name: 'instance', in: 'path', required: true, schema: { type: 'string' }, description: 'Proxy instance mount path.' },
  proxyPath: { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Forwarded path on the upstream.' },
  status: { name: 'status', in: 'query', schema: { type: 'string' } },
  action: { name: 'action', in: 'query', schema: { type: 'string' } },
  actorKey: { name: 'actorKey', in: 'query', schema: { type: 'string' } },
  from: { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
  to: { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
} as const;

interface Route {
  method: string;
  /** full path template for the given capabilities */
  path: (cap: OpenApiCapabilities) => string;
  operation: Json;
  /** present only for optional groups */
  enabled?: (cap: OpenApiCapabilities) => boolean;
}

const routes: Route[] = [];

function route(method: string, path: Route['path'], operation: Json, enabled?: Route['enabled']): void {
  routes.push({ method, path, operation, enabled });
}

function op(tag: string, operationId: string, summary: string, extra: Json): Json {
  return { tags: [tag], operationId, summary, ...extra };
}

// ---- Objects (always) ----
route('get', (c) => `${c.prefix}/objects/{name}`, op(OPENAPI_TAGS.OBJECTS, 'listRecords', 'List records', {
  description:
    'Returns one page of records. Row scope (`all`/`own`/`team`), field exclusions and sensitive-field masking follow the identity\'s RBAC.',
  parameters: [P.name, P.filter, P.sort, P.fields, P.limit, P.offset],
  responses: { 200: ok('A page of records.', LIST_REF), ...errors() },
}));
route('post', (c) => `${c.prefix}/objects/{name}`, op(OPENAPI_TAGS.OBJECTS, 'createRecord', 'Create a record', {
  description: 'Validates the body against the schema, runs RBAC and script hooks, and audits the write.',
  parameters: [P.name],
  requestBody: { required: true, ...json(GENERIC_OBJECT) },
  responses: { 201: ok('Record created.', RECORD_REF), ...errors('400', '403', '409') },
}));
route('patch', (c) => `${c.prefix}/objects/{name}`, op(OPENAPI_TAGS.OBJECTS, 'updateManyRecords', 'Update many records', {
  description: 'Applies the same changes to every id in one all-or-nothing transaction.',
  parameters: [P.name],
  requestBody: { required: true, ...json({ type: 'object', required: ['ids', 'changes'], properties: { ids: { type: 'array', items: { type: 'string' } }, changes: GENERIC_OBJECT } }) },
  responses: { 200: ok('Ids updated.', IDLIST_REF), ...errors('400', '403', '404') },
}));
route('delete', (c) => `${c.prefix}/objects/{name}`, op(OPENAPI_TAGS.OBJECTS, 'deleteManyRecords', 'Delete many records', {
  description: 'Deletes every id in one all-or-nothing transaction, subject to RBAC row scope.',
  parameters: [P.name],
  requestBody: { required: true, ...json({ type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }) },
  responses: { 200: ok('Ids deleted.', IDLIST_REF), ...errors('400', '403', '404') },
}));
route('get', (c) => `${c.prefix}/objects/{name}/{id}`, op(OPENAPI_TAGS.OBJECTS, 'getRecord', 'Get one record', {
  description: 'A row outside the identity\'s row scope is reported as `404 data.recordNotFound` — it does not leak existence.',
  parameters: [P.name, P.id],
  responses: { 200: ok('The record.', RECORD_REF), ...errors('403', '404') },
}));
route('patch', (c) => `${c.prefix}/objects/{name}/{id}`, op(OPENAPI_TAGS.OBJECTS, 'updateRecord', 'Update one record', {
  description: "Only fields the identity's `update` whitelist allows. Returns the updated record (with `warnings` when an after-hook warns).",
  parameters: [P.name, P.id],
  requestBody: { required: true, ...json(GENERIC_OBJECT) },
  responses: { 200: ok('The updated record.', RECORD_REF), ...errors('400', '403', '404') },
}));
route('delete', (c) => `${c.prefix}/objects/{name}/{id}`, op(OPENAPI_TAGS.OBJECTS, 'deleteRecord', 'Delete one record', {
  description: 'Deletes the record and returns `204` with no body.',
  parameters: [P.name, P.id],
  responses: { 204: { description: 'Deleted.' }, ...errors('403', '404') },
}));

// ---- Schema source (projectDir) ----
route('get', (c) => `${c.prefix}/objects/{name}/schema`, op(OPENAPI_TAGS.SCHEMA, 'getSchemaSource', 'Read the schema source (admin)', {
  parameters: [P.name],
  responses: { 200: ok('Raw schema source.', { type: 'object', properties: { source: { type: 'string' }, version: { type: 'string' } } }), ...errors('403', '404') },
}), (c) => c.projectDir);
route('put', (c) => `${c.prefix}/objects/{name}/schema`, op(OPENAPI_TAGS.SCHEMA, 'putSchemaSource', 'Replace the schema source (admin)', {
  description: 'Validates and atomically writes `schema.json`, then commits it.',
  parameters: [P.name],
  requestBody: { required: true, ...json({ type: 'object', required: ['source'], properties: { source: { type: 'string' }, expectVersion: { type: 'string' }, force: { type: 'boolean' } } }) },
  responses: { 200: ok('Written.', { type: 'object', properties: { ok: { type: 'boolean' }, committed: { type: 'boolean' }, version: { type: 'string' } } }), ...errors('400', '403', '404', '409') },
}), (c) => c.projectDir);

// ---- Scripts (projectDir) ----
route('get', (c) => `${c.prefix}/objects/{name}/scripts/{kind}`, op(OPENAPI_TAGS.SCRIPTS, 'getScriptSource', 'Read a script source', {
  description: '`server` requires a role listed in `adapters.rest.adminRoles`.',
  parameters: [P.name, P.kind],
  responses: { 200: ok('Script source.', { type: 'object', properties: { source: { type: 'string' }, version: { type: 'string' } } }), ...errors('400', '403', '404') },
}), (c) => c.projectDir);
route('put', (c) => `${c.prefix}/objects/{name}/scripts/{kind}`, op(OPENAPI_TAGS.SCRIPTS, 'putScriptSource', 'Write a script source (admin)', {
  description: 'Parses the JavaScript without executing it, writes the file and commits it.',
  parameters: [P.name, P.kind],
  requestBody: { required: true, ...json({ type: 'object', required: ['source'], properties: { source: { type: 'string' }, expectVersion: { type: 'string' } } }) },
  responses: { 200: ok('Written.', { type: 'object', properties: { ok: { type: 'boolean' }, committed: { type: 'boolean' }, version: { type: 'string' } } }), ...errors('400', '403', '404', '409') },
}), (c) => c.projectDir);

// ---- Metadata / permissions / identities ----
route('get', (c) => `${c.prefix}/metadata`, op(OPENAPI_TAGS.METADATA, 'getMetadata', 'Object descriptors for API clients', {
  description: 'Without `object`, returns `{ objects: [...] }` for every readable object; pass `object=<name>` for one. Responses carry an `ETag`.',
  parameters: [P.objectQuery],
  responses: { 200: ok('Descriptor(s).', GENERIC_OBJECT), 304: { description: 'Not modified.' }, ...errors('403', '404') },
}));
route('get', (c) => `${c.prefix}/permissions`, op(OPENAPI_TAGS.PERMISSIONS, 'getPermissions', "Effective permissions for the identity", {
  responses: { 200: ok('Resolved permissions.', { type: 'object', properties: { objects: { type: 'array', items: GENERIC_OBJECT } } }), ...errors() },
}));
route('get', (c) => `${c.prefix}/identities`, op(OPENAPI_TAGS.IDENTITIES, 'getIdentities', 'On-behalf-of identity directory (admin)', {
  description: 'Returns the static `mcp.identities` directory; a function resolver has no introspectable entries (`[]`).',
  responses: { 200: ok('Identity directory.', { type: 'object', properties: { identities: { type: 'array', items: GENERIC_OBJECT } } }), ...errors('403') },
}));

// ---- Audit (audit subsystem) ----
route('get', (c) => `${c.prefix}/audit`, op(OPENAPI_TAGS.AUDIT, 'queryAudit', 'Query the audit trail', {
  description: 'A regular identity only sees its own events; roles in `adminRoles` may query any actor or the whole trail.',
  parameters: [P.actorKey, P.action, P.objectQuery, P.from, P.to, P.limit, P.offset],
  responses: { 200: ok('A page of audit events.', LIST_REF), ...errors('403') },
}), (c) => c.audit);

// ---- Approvals (tool executor) ----
route('get', (c) => `${c.prefix}/approvals`, op(OPENAPI_TAGS.APPROVALS, 'listApprovals', 'List pending approvals (admin)', {
  description: 'Paged approval queue; gated to `adminRoles` because the queue carries request arguments.',
  parameters: [P.status, P.action, P.actorKey, P.from, P.to, P.limit, P.offset],
  responses: { 200: ok('A page of approvals.', LIST_REF), ...errors('403') },
}), (c) => c.approvals);
route('post', (c) => `${c.prefix}/approvals/{key}/approve`, op(OPENAPI_TAGS.APPROVALS, 'approveApproval', 'Approve a pending call (admin)', {
  parameters: [P.approvalKey],
  responses: { 200: ok('Resolved.', { type: 'object', properties: { approvalKey: { type: 'string' }, status: { type: 'string' }, approver: { type: 'string' } } }), ...errors('403', '404') },
}), (c) => c.approvals);
route('post', (c) => `${c.prefix}/approvals/{key}/reject`, op(OPENAPI_TAGS.APPROVALS, 'rejectApproval', 'Reject a pending call (admin)', {
  parameters: [P.approvalKey],
  responses: { 200: ok('Resolved.', { type: 'object', properties: { approvalKey: { type: 'string' }, status: { type: 'string' }, approver: { type: 'string' } } }), ...errors('403', '404') },
}), (c) => c.approvals);

// ---- Guardrails (policies dir) ----
route('get', (c) => `${c.prefix}/guardrails/policies`, op(OPENAPI_TAGS.GUARDRAILS, 'listGuardrailPolicies', 'List guardrail policy files (admin)', {
  responses: { 200: ok('Policy files.', { type: 'object', properties: { policies: { type: 'array', items: GENERIC_OBJECT } } }), ...errors('403') },
}), (c) => c.guardrails);
route('get', (c) => `${c.prefix}/guardrails/policies/{name}`, op(OPENAPI_TAGS.GUARDRAILS, 'getGuardrailPolicy', 'Read a guardrail policy (admin)', {
  parameters: [P.policyName],
  responses: { 200: ok('Policy source.', { type: 'object', properties: { source: { type: 'string' }, version: { type: 'string' } } }), ...errors('403', '404') },
}), (c) => c.guardrails);
route('put', (c) => `${c.prefix}/guardrails/policies/{name}`, op(OPENAPI_TAGS.GUARDRAILS, 'putGuardrailPolicy', 'Write a guardrail policy (admin)', {
  parameters: [P.policyName],
  requestBody: { required: true, ...json({ type: 'object', required: ['source'], properties: { source: { type: 'string' }, expectVersion: { type: 'string' } } }) },
  responses: { 200: ok('Written.', { type: 'object', properties: { ok: { type: 'boolean' }, committed: { type: 'boolean' }, version: { type: 'string' } } }), ...errors('400', '403', '404', '409') },
}), (c) => c.guardrails);
route('get', (c) => `${c.prefix}/guardrails/policies/{name}/history`, op(OPENAPI_TAGS.GUARDRAILS, 'getGuardrailPolicyHistory', 'Guardrail policy history (admin)', {
  parameters: [P.policyName],
  responses: { 200: ok('Revisions.', { type: 'array', items: GENERIC_OBJECT }), ...errors('403', '404') },
}), (c) => c.guardrails);

// ---- Proxy (resolver configured) ----
route('get', (c) => `${c.prefix}/proxy`, op(OPENAPI_TAGS.PROXY, 'listProxyInstances', 'List proxy instances', {
  responses: { 200: ok('Instances.', GENERIC_OBJECT), ...errors('403') },
}), (c) => c.proxy);
for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
  route(method, (c) => `${c.prefix}/proxy/{instance}/{path}`, op(OPENAPI_TAGS.PROXY, `proxy${method.charAt(0).toUpperCase()}${method.slice(1)}`, `Proxy a ${method.toUpperCase()} to an upstream`, {
    description: 'The `proxy.resolver` decides the upstream URL and access rules; the engine forwards the request and returns the response.',
    parameters: [P.instance, P.proxyPath],
    responses: { 200: ok('Upstream response.', GENERIC_OBJECT), ...errors('400', '403', '404', '502', '504') },
  }), (c) => c.proxy);
}

// ---- Events SSE (events adapter) ----
route('get', (c) => `${c.events!.prefix}/events`, op(OPENAPI_TAGS.EVENTS, 'subscribeEvents', 'Live event stream (SSE)', {
  description: 'A `text/event-stream` of schema/data change events, with replay.',
  responses: { 200: { description: 'Event stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } }, ...errors() },
}), (c) => c.events !== undefined);

// ---- Ingress (config.ingress) ----
route('post', (c) => `${c.ingress!.prefix}/ingress/{source}`, op(OPENAPI_TAGS.INGRESS, 'ingestEvent', 'Receive an inbound webhook', {
  description: "Calls the project's `ingress.verifier` with the raw body and headers; a `null` result is `401`. On success the handler runs and the receipt is audited.",
  parameters: [P.source],
  requestBody: { required: true, ...json(GENERIC_OBJECT) },
  responses: { 202: ok('Accepted and handled.', { type: 'object', properties: { accepted: { type: 'boolean' } } }), ...errors('401', '429') },
  security: [],
}), (c) => c.ingress !== undefined);

// ---- Ops (always) ----
route('get', () => '/health', op(OPENAPI_TAGS.OPS, 'health', 'Liveness probe', {
  description: 'Returns `ok` when the process is up. Never touches the database.',
  responses: { 200: ok('Process is up.', { type: 'object', properties: { status: { type: 'string' } } }) },
  security: [],
}));
route('get', () => '/ready', op(OPENAPI_TAGS.OPS, 'ready', 'Readiness probe', {
  description: 'Runs `SELECT 1` against PostgreSQL: `200` when reachable, `503` when not.',
  responses: { 200: ok('Database reachable.', { type: 'object', properties: { status: { type: 'string' }, db: { type: 'string' } } }), 503: { description: 'Database unreachable.' } },
  security: [],
}));
route('get', () => '/version', op(OPENAPI_TAGS.OPS, 'version', 'Engine name and version', {
  responses: { 200: ok('Build identity.', { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' } } }) },
  security: [],
}));

// ---- MCP (opaque JSON-RPC) ----
route('post', (c) => c.mcp!.endpoint, op(OPENAPI_TAGS.OPS, 'mcp', 'MCP (JSON-RPC over streamable HTTP)', {
  description: 'The Model Context Protocol endpoint (JSON-RPC 2.0). See the MCP guide for the transport and headers.',
  responses: { 200: { description: 'JSON-RPC response.' }, ...errors() },
}), (c) => c.mcp !== undefined);

/** assemble the OpenAPI 3.1 document. */
export function buildOpenApiDocument(input: BuildOpenApiInput): OpenApiDocument {
  const cap = input.capabilities;
  const objects = new Map(input.objects.map((o) => [o.name, o]));

  const schemas: Record<string, unknown> = {
    ObjectRecord: { type: 'object', additionalProperties: true, description: "A record shaped by the object's `schema.json`." },
    ListResult: {
      type: 'object',
      required: ['rows', 'total', 'limit', 'offset'],
      properties: {
        rows: { type: 'array', items: RECORD_REF },
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
    },
    IdList: {
      type: 'object',
      properties: {
        updated: { type: 'array', items: { type: 'string' } },
        deleted: { type: 'array', items: { type: 'string' } },
      },
    },
    Error: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', description: 'Stable error code, e.g. `rbac.denied.read`.' },
            message: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  };

  if (input.generic !== true) {
    for (const obj of input.objects) {
      const { record, create, update } = objectSchemas(obj, objects);
      schemas[obj.name] = record;
      schemas[`${obj.name}Create`] = create;
      schemas[`${obj.name}Update`] = update;
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    if (r.enabled !== undefined && !r.enabled(cap)) continue;
    const path = r.path(cap);
    const item = paths[path] ?? (paths[path] = {});
    item[r.method] = r.operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: input.info?.title ?? 'WeaveKit Engine REST API',
      version: input.info?.version ?? version,
      description:
        input.info?.description ??
        'The HTTP API exposed by `@weave-kit/engine`. Object routes are generic — `{name}` is an object from your `schema.json`. Every error response uses the same body: `{ "error": { "code", "message", "params?" } }`. Authentication is a bearer API key from `auth.source`, and RBAC is enforced in the data-access layer.',
    },
    servers: [{ url: input.server ?? 'http://localhost:3000', description: 'Local development' }],
    tags: Object.entries(OPENAPI_TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key present in `auth.source` (or resolved by an `AuthResolver`).' },
      },
      schemas,
      parameters: P as unknown as Record<string, unknown>,
      responses: {
        Error: { description: 'Uniform error body.', ...json({ $ref: '#/components/schemas/Error' }) },
      },
    },
    paths,
  };
}

import type { ObjectDefinition } from '../../core/index.js';

/**
 * OpenAPI 3.1 document generator for the engine's REST surface.
 *
 * The generator is a pure transformation of the loaded object definitions plus a
 * capability snapshot derived from `weavekit.config.ts` — no database, no server.
 * It is identity-agnostic: the document describes the API shape once; per-identity
 * permissions are available at runtime from `GET {prefix}/metadata` and
 * `GET {prefix}/permissions`.
 */

/** OpenAPI tags (grouping), single source of truth. */
export const OPENAPI_TAGS = {
  OBJECTS: 'Objects',
  SCHEMA: 'Schema',
  SCRIPTS: 'Scripts',
  METADATA: 'Metadata',
  PERMISSIONS: 'Permissions',
  IDENTITIES: 'Identities',
  AUDIT: 'Audit',
  APPROVALS: 'Approvals',
  GUARDRAILS: 'Guardrails',
  PROXY: 'Proxy',
  EVENTS: 'Events',
  INGRESS: 'Ingress',
  OPS: 'Ops',
} as const;
export type OpenApiTag = typeof OPENAPI_TAGS[keyof typeof OPENAPI_TAGS];

export const OPENAPI_TAG_DESCRIPTIONS: Record<OpenApiTag, string> = {
  Objects: 'Generic CRUD over the objects in your schema.',
  Schema: "Read or replace an object's `schema.json` (admin).",
  Scripts: 'Sandboxed `server.js` hook sources.',
  Metadata: 'Object descriptors for API clients.',
  Permissions: "The identity's effective permissions per object.",
  Identities: 'The static on-behalf-of identity directory (admin).',
  Audit: 'The immutable event log (requires the audit subsystem).',
  Approvals: 'The human approval queue (requires the tool executor).',
  Guardrails: 'Guardrail policy sources and history (admin).',
  Proxy: 'The generic proxy to external instances.',
  Events: 'The outbound live-event stream (SSE).',
  Ingress: 'Inbound webhooks from external providers.',
  Ops: 'Liveness, readiness and version — always registered.',
};

/** which optional route groups are present, derived from the project config. */
export interface OpenApiCapabilities {
  /** REST prefix (default `/api`). */
  prefix: string;
  /** events SSE group (present when the events adapter is enabled). */
  events?: { prefix: string };
  /** ingress group (present when `config.ingress` is set). */
  ingress?: { prefix: string };
  /** audit subsystem enabled → `GET {prefix}/audit`. */
  audit: boolean;
  /** tool executor present → approvals routes. */
  approvals: boolean;
  /** `config.proxy.resolver` set → proxy routes. */
  proxy: boolean;
  /** `tools.guardrails.policies` is a directory → policy file routes. */
  guardrails: boolean;
  /** a project dir is available → schema/scripts/pages source routes. */
  projectDir: boolean;
  /** MCP adapter (documented as an opaque JSON-RPC endpoint). */
  mcp?: { endpoint: string };
}

export interface BuildOpenApiInput {
  /** loaded object definitions (may be empty for the generic reference). */
  objects: readonly ObjectDefinition[];
  capabilities: OpenApiCapabilities;
  /** default server URL. */
  server?: string;
  /** omit per-object component schemas (used for the generic docs reference). */
  generic?: boolean;
  info?: { title?: string; description?: string; version?: string };
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: { url: string; description?: string }[];
  tags: { name: string; description?: string }[];
  security: Record<string, string[]>[];
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
    parameters: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
  paths: Record<string, Record<string, unknown>>;
}

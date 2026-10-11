import { SchemaError, type Locale } from '../../core/index.js';
import { describeObject, listObjectDescriptors } from '../../core/object/describe.js';
import type { McpSession } from './session.js';
import type { McpEngine } from './types.js';

/**
 * MCP resources: the engine's metadata exposed as readable URIs. The surface is
 * derived from the schema (no config) and filtered by the session identity's
 * RBAC — the same view `list_objects` / `describe_object` return, so an agent can
 * pull schema context as resources instead of tool calls.
 *
 *   weavekit://objects           → the objects the identity can read
 *   weavekit://objects/{name}    → the full descriptor (fields, relations, perms)
 */

export const MCP_RESOURCES = {
  OBJECTS: 'weavekit://objects',
  OBJECT_PREFIX: 'weavekit://objects/',
} as const;

/** one entry in `resources/list` */
export interface McpResourceEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

/** one entry in the `resources/read` contents array */
export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

const JSON_MIME = 'application/json';

/** the resources visible to the session identity (RBAC-filtered) */
export function listResources(engine: McpEngine, session: McpSession): McpResourceEntry[] {
  const objects = listObjectDescriptors(engine.registry, session.user.roles);
  return [
    {
      uri: MCP_RESOURCES.OBJECTS,
      name: 'objects',
      description: 'Objects the current identity can read (name, labels, description)',
      mimeType: JSON_MIME,
    },
    ...objects.map((o) => ({
      uri: `${MCP_RESOURCES.OBJECT_PREFIX}${o.name}`,
      name: o.name,
      ...(o.description === undefined ? {} : { description: o.description }),
      mimeType: JSON_MIME,
    })),
  ];
}

/**
 * Read one resource. Throws `data.objectUnknown` / `rbac.denied.read` (from
 * `describeObject`) or `http.notFound` for a URI outside the surface.
 */
export function readResource(engine: McpEngine, session: McpSession, uri: string, locale: Locale): McpResourceContent {
  if (uri === MCP_RESOURCES.OBJECTS) {
    const objects = listObjectDescriptors(engine.registry, session.user.roles);
    return { uri, mimeType: JSON_MIME, text: JSON.stringify({ objects }) };
  }
  if (uri.startsWith(MCP_RESOURCES.OBJECT_PREFIX)) {
    const name = uri.slice(MCP_RESOURCES.OBJECT_PREFIX.length);
    const descriptor = describeObject(engine.registry, name, session.user.roles, locale);
    return { uri, mimeType: JSON_MIME, text: JSON.stringify(descriptor) };
  }
  throw new SchemaError('http.notFound', {}, locale);
}

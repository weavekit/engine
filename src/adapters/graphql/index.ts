import type { FastifyInstance } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import type { Locale } from '../../core/index.js';
import type { Authenticator } from '../auth/index.js';
import { buildGraphQLSchema } from './schema.js';
import { registerGraphQLRoutes } from './http.js';
import type { EngineGraphQLConfig, GraphQLEngine } from './types.js';

/**
 * GraphQL adapter assembly. `registerGraphQL` compiles the object registry into
 * a GraphQL schema and mounts the `/graphql` endpoint on the fastify app. The
 * adapter reuses the engine's data-access/RBAC/audit layer — the assembly layer
 * (createEngine) injects the same `dataAccess` + `authenticator` as REST/MCP.
 *
 * Disabled unless `adapters.graphql.enabled` is true (decision 7): the engine
 * only mounts the endpoint when a project opts in.
 */

export interface GraphQLDeps {
  engine: GraphQLEngine;
  authenticator: Authenticator;
  graphql: EngineGraphQLConfig | undefined;
  locale: Locale;
}

export interface GraphQLServerHandle {
  /** the compiled schema (read-only; exposed for tooling / SDL export) */
  readonly schema: GraphQLSchema;
  close(): Promise<void>;
}

/** Register the GraphQL endpoint on an existing fastify app. */
export function registerGraphQL(app: FastifyInstance, deps: GraphQLDeps): GraphQLServerHandle {
  const schema = buildGraphQLSchema(deps.engine);
  registerGraphQLRoutes(app, {
    engine: deps.engine,
    authenticator: deps.authenticator,
    schema,
    graphql: deps.graphql,
    locale: deps.locale,
  });
  return {
    schema,
    async close() {
      // per-request execution holds no persistent resources yet; reserved for
      // loaders/schedulers added in later phases.
    },
  };
}

export { buildGraphQLSchema, printGraphQLSchema } from './schema.js';
export { registerGraphQLRoutes } from './http.js';
export type { GraphQLRouteDeps } from './http.js';
export type { GraphQLEngine, EngineGraphQLConfig, GraphQLSecurityConfig } from './types.js';

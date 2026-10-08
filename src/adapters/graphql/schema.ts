import { GraphQLInt, GraphQLObjectType, GraphQLSchema, printSchema } from 'graphql';
import type { GraphQLEngine } from './types.js';

/**
 * Compile the object registry into a GraphQL schema.
 *
 * Phase 0 ships a minimal placeholder so the `/graphql` endpoint is wired and
 * authenticated end to end; the real object types + Query/Mutation surface
 * (with field-level RBAC projection) lands in Phase 1. Build is **programmatic**
 * (per the plan) so `printSchema` can emit SDL for `weave graphql:schema`.
 */
export function buildGraphQLSchema(engine: GraphQLEngine): GraphQLSchema {
  const Query = new GraphQLObjectType({
    name: 'Query',
    description: 'WeaveKit GraphQL endpoint (Phase 0 skeleton).',
    fields: {
      _objectCount: {
        type: GraphQLInt,
        description: 'Number of objects in the schema registry.',
        resolve: () => engine.registry.list().length,
      },
    },
  });
  return new GraphQLSchema({ query: Query });
}

/** SDL for the compiled schema (used by `weave graphql:schema` in a later phase). */
export function printGraphQLSchema(schema: GraphQLSchema): string {
  return printSchema(schema);
}

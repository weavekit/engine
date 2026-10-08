import { GraphQLScalarType, Kind, valueFromASTUntyped } from 'graphql';

/**
 * The `JSON` scalar — an arbitrary JSON value. Used for `json`/`jsonb` object
 * fields and the free-form `filter` argument (which mirrors the REST/MCP filter
 * contract: exact values, operator objects, and a top-level `$or`).
 */
export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value (object, array, or scalar).',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => (ast.kind === Kind.NULL ? null : valueFromASTUntyped(ast)),
});

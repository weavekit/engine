import { visit, type DocumentNode } from 'graphql';
import { SchemaError, type Locale } from '../../core/index.js';
import type { GraphQLSecurityConfig } from './types.js';

/**
 * Query hardening (Phase 1: depth / complexity / alias). Enforced **before**
 * execution. `introspection` and the persisted-operation `allowList` land in
 * Phase 4. Limits are computed over the parsed document with `visit`.
 */

/** default maximum selection-set depth when the caller doesn't configure one */
export const GRAPHQL_DEFAULT_MAX_DEPTH = 10;

export interface ResolvedSecurity {
  maxDepth: number;
  maxComplexity?: number;
  maxAliases?: number;
}

/** apply defaults to a security config */
export function resolveSecurity(config: GraphQLSecurityConfig | undefined): ResolvedSecurity {
  return {
    maxDepth: config?.maxDepth ?? GRAPHQL_DEFAULT_MAX_DEPTH,
    ...(config?.maxComplexity === undefined ? {} : { maxComplexity: config.maxComplexity }),
    ...(config?.maxAliases === undefined ? {} : { maxAliases: config.maxAliases }),
  };
}

/** reject a document that exceeds the configured depth / complexity / alias limits */
export function validateQuery(document: DocumentNode, security: ResolvedSecurity, locale: Locale): void {
  let depth = 0;
  let maxDepth = 0;
  let fields = 0;
  let aliases = 0;
  visit(document, {
    SelectionSet: {
      enter: () => {
        depth += 1;
        if (depth > maxDepth) maxDepth = depth;
      },
      leave: () => {
        depth -= 1;
      },
    },
    Field: {
      enter: (node) => {
        fields += 1;
        if (node.alias !== undefined) aliases += 1;
      },
    },
  });

  if (security.maxAliases !== undefined && aliases > security.maxAliases) {
    throw new SchemaError('graphql.aliasExceeded', { count: aliases, max: security.maxAliases }, locale);
  }
  if (maxDepth > security.maxDepth) {
    throw new SchemaError('graphql.depthExceeded', { depth: maxDepth, max: security.maxDepth }, locale);
  }
  if (security.maxComplexity !== undefined && fields > security.maxComplexity) {
    throw new SchemaError('graphql.complexityExceeded', { cost: fields, max: security.maxComplexity }, locale);
  }
}

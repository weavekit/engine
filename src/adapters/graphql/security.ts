import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  NoSchemaIntrospectionCustomRule,
  print,
  specifiedRules,
  visit,
  type DocumentNode,
  type ValidationRule,
} from 'graphql';
import { SchemaError, type Locale } from '../../core/index.js';
import { PAGINATION } from '../../runtime/data-access/index.js';
import type { GraphQLSecurityConfig } from './types.js';

/**
 * Query hardening (depth / complexity / alias / introspection / allow-list).
 * Limits are computed from the parsed document with `visit`; introspection is a
 * validation rule; the allow list is a set of approved operation hashes loaded
 * once at registration (see `weave graphql:allowlist` in a later phase).
 */

/** default maximum selection-set depth when the caller doesn't configure one */
export const GRAPHQL_DEFAULT_MAX_DEPTH = 10;

export interface ResolvedSecurity {
  maxDepth: number;
  maxComplexity?: number;
  maxAliases?: number;
  /** allow `__schema` / `__type` introspection; defaults to true */
  introspection: boolean;
  /** approved operation hashes (enabled → only listed operations run) */
  allowList?: ReadonlySet<string>;
}

/** a stable content hash of an operation (the allow-list key) */
export function operationHash(document: DocumentNode): string {
  return createHash('sha256').update(print(document)).digest('hex');
}

/** load the approved-operation hashes from a Git-versioned JSON file (fail loud on misconfig) */
function loadAllowList(file: string | undefined): ReadonlySet<string> {
  if (file === undefined) {
    throw new Error('graphql.security.allowList.enabled requires "file" (the Git-versioned allow-list path)');
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { operations?: unknown }).operations;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
    throw new Error(`graphql allow-list "${file}" must be a JSON string array or { "operations": string[] }`);
  }
  return new Set(list as string[]);
}

/** apply defaults to a security config (loads the allow list once) */
export function resolveSecurity(config: GraphQLSecurityConfig | undefined): ResolvedSecurity {
  return {
    maxDepth: config?.maxDepth ?? GRAPHQL_DEFAULT_MAX_DEPTH,
    introspection: config?.introspection ?? true,
    ...(config?.maxComplexity === undefined ? {} : { maxComplexity: config.maxComplexity }),
    ...(config?.maxAliases === undefined ? {} : { maxAliases: config.maxAliases }),
    ...(config?.allowList?.enabled === true ? { allowList: loadAllowList(config.allowList.file) } : {}),
  };
}

/** validation rules for this policy (adds the no-introspection rule when disabled) */
export function validationRules(security: ResolvedSecurity): readonly ValidationRule[] {
  return security.introspection ? specifiedRules : [...specifiedRules, NoSchemaIntrospectionCustomRule];
}

/** reject a document that is not allow-listed or exceeds the depth / complexity / alias limits */
export function validateQuery(document: DocumentNode, security: ResolvedSecurity, locale: Locale): void {
  if (security.allowList !== undefined && !security.allowList.has(operationHash(document))) {
    throw new SchemaError('graphql.allowList.denied', {}, locale);
  }

  let depth = 0;
  let maxDepth = 0;
  let cost = 0;
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
        if (node.alias !== undefined) aliases += 1;
        // cost is weighted by the field's `limit` argument (a list field can
        // return up to `limit` rows), capped at the engine pagination ceiling
        let weight = 1;
        const limitArg = node.arguments?.find((a) => a.name.value === 'limit');
        if (limitArg !== undefined && limitArg.value.kind === 'IntValue') {
          const n = Number(limitArg.value.value);
          if (Number.isFinite(n) && n > 0) weight = Math.min(Math.floor(n), PAGINATION.MAX_LIMIT);
        }
        cost += weight;
      },
    },
  });

  if (security.maxAliases !== undefined && aliases > security.maxAliases) {
    throw new SchemaError('graphql.aliasExceeded', { count: aliases, max: security.maxAliases }, locale);
  }
  if (maxDepth > security.maxDepth) {
    throw new SchemaError('graphql.depthExceeded', { depth: maxDepth, max: security.maxDepth }, locale);
  }
  if (security.maxComplexity !== undefined && cost > security.maxComplexity) {
    throw new SchemaError('graphql.complexityExceeded', { cost, max: security.maxComplexity }, locale);
  }
}

import { GraphQLError } from 'graphql';
import {
  FIELD_TYPES,
  RECORD_META_ID_FIELD,
  SchemaError,
  type Locale,
  type ObjectDefinition,
} from '../../core/index.js';
import type { DataAccessContext, Filter, Sort } from '../../runtime/data-access/index.js';
import type { GraphQLContext } from './types.js';

/**
 * Root Query resolvers. Each one builds a {@link DataAccessContext} from the
 * request context and calls the RBAC-decorated data-access layer — so row scope
 * (`own`/`department`), field exclusion and (for writes) auditing come from the
 * existing layer, exactly as REST/MCP. A thrown {@link SchemaError} is mapped to
 * a GraphQLError carrying its stable `extensions.code`.
 */

interface ListArgs {
  filter?: unknown;
  sort?: Sort[];
  limit?: number;
  offset?: number;
}

/** the columns a read projects: every non-details field plus the derived `weave_id` */
function projectionOf(def: ObjectDefinition): string[] {
  return [...def.fields.filter((f) => f.type !== FIELD_TYPES.DETAILS).map((f) => f.name), RECORD_META_ID_FIELD];
}

function dataContext(context: GraphQLContext): DataAccessContext {
  return {
    pool: context.engine.pool,
    registry: context.engine.registry,
    subject: context.subject,
    locale: context.engine.locale,
  };
}

/** map a thrown SchemaError to a GraphQLError carrying its stable code */
async function guard<T>(fn: () => Promise<T>, locale: Locale): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new GraphQLError(error.localize(locale), {
        extensions: {
          code: error.code,
          ...(Object.keys(error.params).length === 0 ? {} : { params: error.params }),
        },
      });
    }
    throw error;
  }
}

/** `<object>` — a page of records, row-scoped by the identity's read RBAC */
export function listResolver(objectName: string) {
  return async (
    _parent: unknown,
    args: ListArgs,
    context: GraphQLContext,
  ): Promise<{ rows: unknown[]; total: number }> => {
    const def = context.engine.registry.get(objectName);
    if (def === undefined) {
      throw new GraphQLError(`unknown object "${objectName}"`, { extensions: { code: 'data.objectUnknown' } });
    }
    return guard(
      () =>
        context.engine.dataAccess.find(
          objectName,
          {
            ...(args.filter === undefined ? {} : { filter: args.filter as Filter }),
            ...(args.sort === undefined ? {} : { sort: args.sort }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            fields: projectionOf(def),
          },
          dataContext(context),
        ),
      context.engine.locale,
    );
  };
}

/** `<object>_by_id` — one record by its `weave_id` (record_key), or null */
export function singleResolver(objectName: string) {
  return async (_parent: unknown, args: { id: string }, context: GraphQLContext): Promise<unknown> => {
    const record = await guard(
      () => context.engine.dataAccess.findOne(objectName, args.id, dataContext(context)),
      context.engine.locale,
    );
    return record ?? null;
  };
}

/** `create<Object>(data:)` — create one record (RBAC-checked + audited by data-access) */
export function createResolver(objectName: string) {
  return async (_parent: unknown, args: { data: Record<string, unknown> }, context: GraphQLContext): Promise<unknown> => {
    return guard(
      () => context.engine.dataAccess.create(objectName, args.data, dataContext(context)),
      context.engine.locale,
    );
  };
}

/** `update<Object>(id:, changes:)` — update one record by its `weave_id` */
export function updateResolver(objectName: string) {
  return async (
    _parent: unknown,
    args: { id: string; changes: Record<string, unknown> },
    context: GraphQLContext,
  ): Promise<unknown> => {
    return guard(
      () => context.engine.dataAccess.update(objectName, args.id, args.changes, dataContext(context)),
      context.engine.locale,
    );
  };
}

/** `delete<Object>(id:)` — delete one record; returns true (throws when absent/denied) */
export function deleteResolver(objectName: string) {
  return async (_parent: unknown, args: { id: string }, context: GraphQLContext): Promise<boolean> => {
    await guard(() => context.engine.dataAccess.delete(objectName, args.id, dataContext(context)), context.engine.locale);
    return true;
  };
}

/** `transition<Object>(id:, action:, payload:)` — run a workflow action */
export function transitionResolver(objectName: string) {
  return async (
    _parent: unknown,
    args: { id: string; action: string; payload?: Record<string, unknown> },
    context: GraphQLContext,
  ): Promise<unknown> => {
    return guard(
      () =>
        context.engine.dataAccess.transition(
          objectName,
          args.id,
          args.action,
          dataContext(context),
          args.payload ?? undefined,
        ),
      context.engine.locale,
    );
  };
}

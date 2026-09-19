/**
 * REST contract layer types — framework-agnostic pure contract.
 * No fastify/data-access imports: only neutral query/error shapes that the
 * adapter layer maps onto the data-access contracts.
 */

 /** one parsed sort clause; `direction` is validated by the adapter layer against SORT_DIRS */
export interface ApiSort {
  field: string;
  direction: string;
}

/** parsed REST list query (neutral syntax — no data-access coupling) */
export interface ListQuery {
  /** decoded filter object (was a JSON string on the wire) */
  filter?: Record<string, unknown>;
  sort?: ApiSort[];
  fields?: string[];
  limit?: number;
  offset?: number;
}

/** uniform error body returned by every REST endpoint */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    params?: Record<string, unknown>;
  };
}

/** HTTP status + body produced by {@link mapSchemaError} */
export interface ApiErrorSpec {
  status: number;
  body: ApiErrorBody;
}

/** paginated list response envelope (pagination convention, consumed by the client SDK) */
export interface RestResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

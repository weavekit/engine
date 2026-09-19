/**
 * Browser-safe schema-constant surface (`@weave-kit/engine/values`).
 *
 * Aggregates every pure, import-free `values.ts` module so frontends and other
 * consumers can share the exact engine constants at runtime WITHOUT pulling the
 * Node server runtime (pg/fastify/isolated-vm/…) into a browser bundle.
 *
 * **Hard rule**: every module re-exported here must stay import-free (pure
 * `as const`). Adding an import breaks the browser-safety guarantee — guarded
 * by `tests/unit/values-browser-safe.test.ts`.
 */
export * from './core/types/values.js';
export * from './runtime/data-access/values.js';
export * from './core/formula/values.js';
export * from './core/tools/values.js';
export * from './core/script/values.js';
export * from './cli/types/values.js';

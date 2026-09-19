/**
 * Experimental surface — `@weave-kit/engine/experimental`.
 *
 * Modules here are under active development and **may change in a minor
 * release**. They are deliberately kept out of the stable `.` entry so the
 * stable contract stays small and reviewable; import from here only when the
 * stable surface does not cover your need. Everything not re-exported by `.`
 * or `./experimental` is internal and not part of any contract.
 */
export * from './runtime/metadata/index.js';
export * from './runtime/tunnel/index.js';
export * from './adapters/ops/index.js';
export * from './infrastructure/index.js';

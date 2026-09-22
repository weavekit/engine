/**
 * Object validation entry point. The implementation is split by concern under
 * `./validate/` (primitives, labels, field, permissions, indexes, formulas,
 * object); this barrel keeps the stable `./validate.js` import path.
 */
export { validateObject } from './validate/object.js';
export type { ValidateOptions } from './validate/object.js';

import type { ReadScope } from './values.js';

export type { ReadScope } from './values.js';

/** per-role permissions for one object (roles come from the user system) */
export interface PermissionDefinition {
  read?: ReadScope;
  /**
   * row scope for writes (update/delete); defaults to `read` when unset. Lets a
   * role read narrowly but manage broadly (or vice versa).
   */
  manage?: ReadScope;
  create?: boolean;
  /** true = all fields updatable; string[] = whitelist; false/undefined = none (fail-closed) */
  update?: boolean | string[];
  delete?: boolean;
  fields?: {
    /** fields hidden from read output (and never surfaced to the identity's MCP tools) */
    exclude?: string[];
    /**
     * optional create field whitelist: the only fields this role may write on
     * create. Undefined = unrestricted (backward compatible); [] = none;
     * otherwise the whitelist. Required fields must be listed (schema-validated).
     */
    create?: string[];
  };
}

export type Permissions = Record<string, PermissionDefinition>;

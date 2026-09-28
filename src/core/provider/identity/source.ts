import type { IdentityPullResult } from './types.js';

/**
 * Identity **provisioning** seam: a source pulls a normalized user/department
 * snapshot that the sync engine upserts into the local directory. Sources are
 * injected via config (no global registry) — the engine ships `pg` and
 * `function`; enterprise implements SCIM/LDAP/HRIS against this same contract.
 */
export interface IdentitySource {
  /** value stored as `weavekit_user/department.external_source` */
  readonly name: string;
  /** pull a snapshot (pass the previous cursor for incremental sources) */
  pull(cursor?: string): Promise<IdentityPullResult>;
  capabilities?: {
    /** `pull(cursor)` returns only changes since the cursor */
    incremental?: boolean;
    /** the source knows deletions; the sync may soft-disable missing rows */
    deactivates?: boolean;
  };
}

/** contract version for `IdentitySource` implementers (stable seam) */
export const IDENTITY_SOURCE_API = 1;

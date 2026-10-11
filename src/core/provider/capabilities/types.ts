/**
 * Capabilities (feature/entitlement) read-only seam.
 *
 * The engine **never judges licensing** — it only exposes whatever the host
 * injects. An open-core product (e.g. `@weave-kit/enterprise`, E0) provides a
 * {@link CapabilitiesProvider}; the engine surfaces it verbatim at
 * `GET {prefix}/capabilities` so a console can show/hide advanced features.
 * With no provider configured the engine returns a baseline (no features).
 */
export interface Capabilities {
  /** feature flag → enabled; keys are host-defined (the engine never interprets them) */
  features: Record<string, boolean>;
  /** optional free-form metadata (edition, expiresAt, seats, …); opaque to the engine */
  meta?: Record<string, unknown>;
}

/** a host-injected capability provider (absent = baseline) */
export interface CapabilitiesProvider {
  get(): Capabilities | Promise<Capabilities>;
}

/** contract version for `CapabilitiesProvider` implementers (stable seam) */
export const CAPABILITIES_API = 1;

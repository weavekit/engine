import * as stable from '../../src/index.js';
import * as experimental from '../../src/experimental.js';
import { describe, it, expect } from '../helpers/test.js';

/**
 * Guards the public API tiers (see `docs/reference/public-api.md`):
 *   - `.`             = the stable contract (app / integration authors)
 *   - `./experimental`= unstable internals, explicitly opt-in
 *   - everything else = internal, not importable through the package
 *
 * Only runtime values are asserted (types are erased and covered by typecheck).
 */

function has(ns: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ns, name);
}

/** names any app / integration author may rely on (stable, contract). */
const STABLE_NAMES = [
  'createEngine',
  'buildEngineFromRegistry',
  'createPool',
  'ObjectRegistry',
  'parseSchema',
  'createDataAccess',
  'withRbac',
  'withTx',
  'createProxyForwarder',
  'DEFAULT_PROXY_ALLOW',
  'createSlidingWindow',
  'createAuth',
  'buildAuthenticator',
  'registerObjectRoutes',
  'registerEventsRoutes',
  'buildOpenApiDocument',
  'loadSchemaDir',
  'syncSchema',
  'scaffoldProject',
  'PROJECT_TYPES',
  'FIELD_TYPES',
  'EVENT_TYPES',
  'version',
];

/** internals that must NOT leak into the stable entry anymore. */
const INTERNAL_NAMES = [
  'createEventBus',
  'publisherOf',
  'createAlerts',
  'createIdentityResolver',
  'createTunnelServer',
  'createTunnelForwarder',
  'TunnelRegistry',
  'registerOpsRoutes',
  'readMetadataCache',
  'writeMetadataCache',
  'ensureMetadataTable',
];

describe('public API tiers', () => {
  it('stable entry exposes the contract surface', () => {
    for (const name of STABLE_NAMES) {
      expect(has(stable as Record<string, unknown>, name)).toBe(true);
    }
  });

  it('stable entry does not leak internals', () => {
    for (const name of INTERNAL_NAMES) {
      expect(has(stable as Record<string, unknown>, name)).toBe(false);
    }
  });

  it('experimental entry exposes the internals', () => {
    for (const name of INTERNAL_NAMES) {
      expect(has(experimental as Record<string, unknown>, name)).toBe(true);
    }
  });
});

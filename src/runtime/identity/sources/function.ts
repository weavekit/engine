import type { IdentityPullResult, IdentitySource } from '../../../core/provider/identity/index.js';

/** a caller-supplied provisioning source (e.g. an HR API wrapper) */
export interface FunctionIdentitySourceInput {
  name: string;
  pull: (cursor?: string) => IdentityPullResult | Promise<IdentityPullResult>;
  capabilities?: IdentitySource['capabilities'];
}

/** wrap an async `pull` into an {@link IdentitySource} (config-injected) */
export function createFunctionIdentitySource(input: FunctionIdentitySourceInput): IdentitySource {
  return {
    name: input.name,
    pull: (cursor) => Promise.resolve(input.pull(cursor)),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
  };
}

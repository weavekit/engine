/**
 * Shared CLI helpers for reading runtime facts from a project config without
 * ever surfacing a secret that isn't statically declared.
 */

/** first key of a static `Record<string, …>` map (never a resolver function) */
export function firstStaticKey(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const keys = Object.keys(source as Record<string, unknown>);
  return keys.length > 0 ? keys[0] : undefined;
}

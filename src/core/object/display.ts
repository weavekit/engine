import { DEFAULT_LOCALE, type Locale } from '../i18n/index.js';

/**
 * Resolve an object/field display name from its per-locale `labels` map: the
 * requested locale, then the default locale, then the first declared entry,
 * then `fallback` (usually the object/field name). This is the engine's single
 * label-resolution rule — used by the CLI, the mapping report and the default
 * layout generator, and re-exported from `./layout` for frontend consumers.
 */
export function resolveLabel(
  labels: Record<string, string> | undefined,
  fallback: string,
  locale?: Locale,
): string {
  if (labels === undefined) return fallback;
  if (locale !== undefined) {
    const localized = labels[locale];
    if (localized !== undefined) return localized;
  }
  const defaulted = labels[DEFAULT_LOCALE];
  if (defaulted !== undefined) return defaulted;
  const first = Object.values(labels)[0];
  return first ?? fallback;
}

import { fail, isRecord, LOCALE_TAG, type Vc } from './primitives.js';

/** validate a labels map: keys must be valid BCP-47 locale tags, values non-empty strings */
export function validateLabels(raw: unknown, vc: Vc): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(vc, 'field.labels.notObject');
  const result: Record<string, string> = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (!LOCALE_TAG.test(locale)) fail(vc, 'field.labels.locale.invalid', { locale });
    if (typeof value !== 'string' || value.length === 0) {
      fail(vc, 'field.labels.value.string', { locale });
    }
    result[locale] = value;
  }
  if (Object.keys(result).length === 0) fail(vc, 'field.labels.empty');
  return result;
}

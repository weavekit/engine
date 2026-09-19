import type { MessageKey } from './en.js';
import { en as enCatalog } from './en.js';
import { ar as arCatalog } from './ar.js';
import { de as deCatalog } from './de.js';
import { es as esCatalog } from './es.js';
import { fr as frCatalog } from './fr.js';
import { hi as hiCatalog } from './hi.js';
import { id as idCatalog } from './id.js';
import { ja as jaCatalog } from './ja.js';
import { ko as koCatalog } from './ko.js';
import { pt as ptCatalog } from './pt.js';
import { ru as ruCatalog } from './ru.js';
import { vi as viCatalog } from './vi.js';
import { zh as zhCatalog } from './zh.js';
import { zhHant as zhHantCatalog } from './zh-hant.js';

/**
 * Locale tags — single source of truth (FORMULA_TYPES-style `as const`).
 * Uppercase keys for ergonomic, typo-proof references; values are BCP-47 tags.
 * `Locale` and `SUPPORTED_LOCALES` are derived from this map.
 */
export const LOCALES = {
  EN: 'en',
  ZH_HANT: 'zh-Hant',
  ZH: 'zh',
  JA: 'ja',
  ES: 'es',
  FR: 'fr',
  DE: 'de',
  PT: 'pt',
  RU: 'ru',
  KO: 'ko',
  AR: 'ar',
  HI: 'hi',
  VI: 'vi',
  ID: 'id',
} as const;

export type Locale = typeof LOCALES[keyof typeof LOCALES];
type Catalog = Record<MessageKey, string>;

/** Runtime tag → catalog lookup, derived from LOCALES (zero hardcoded tags). */
const catalogByTag: Record<Locale, Catalog> = {
  [LOCALES.EN]: enCatalog,
  [LOCALES.ZH_HANT]: zhHantCatalog,
  [LOCALES.ZH]: zhCatalog,
  [LOCALES.JA]: jaCatalog,
  [LOCALES.ES]: esCatalog,
  [LOCALES.FR]: frCatalog,
  [LOCALES.DE]: deCatalog,
  [LOCALES.PT]: ptCatalog,
  [LOCALES.RU]: ruCatalog,
  [LOCALES.KO]: koCatalog,
  [LOCALES.AR]: arCatalog,
  [LOCALES.HI]: hiCatalog,
  [LOCALES.VI]: viCatalog,
  [LOCALES.ID]: idCatalog,
};

export const DEFAULT_LOCALE: Locale = LOCALES.EN;

/** All registered locales, always equal to LOCALES' values. */
export const SUPPORTED_LOCALES: readonly Locale[] = Object.freeze(
  (Object.keys(LOCALES) as (keyof typeof LOCALES)[]).map((key) => LOCALES[key]),
);

export type { MessageKey } from './en.js';

/**
 * Resolve a message catalog entry for the given locale and interpolate params.
 * Falls back to English when the locale or a specific key is missing. Unknown
 * `{name}` placeholders without a matching param are left literal (e.g. `{seq}`).
 */
export function translate(
  code: MessageKey,
  params: Record<string, unknown>,
  locale: Locale,
): string {
  const catalog = catalogByTag[locale] ?? enCatalog;
  const template = catalog[code] ?? enCatalog[code];
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/** Named catalogs, all derived from the single `LOCALES`/`catalogByTag` source. */
export const en: Catalog = catalogByTag[LOCALES.EN];
export const ar: Catalog = catalogByTag[LOCALES.AR];
export const de: Catalog = catalogByTag[LOCALES.DE];
export const es: Catalog = catalogByTag[LOCALES.ES];
export const fr: Catalog = catalogByTag[LOCALES.FR];
export const hi: Catalog = catalogByTag[LOCALES.HI];
export const id: Catalog = catalogByTag[LOCALES.ID];
export const ja: Catalog = catalogByTag[LOCALES.JA];
export const ko: Catalog = catalogByTag[LOCALES.KO];
export const pt: Catalog = catalogByTag[LOCALES.PT];
export const ru: Catalog = catalogByTag[LOCALES.RU];
export const vi: Catalog = catalogByTag[LOCALES.VI];
export const zh: Catalog = catalogByTag[LOCALES.ZH];
export const zhHant: Catalog = catalogByTag[LOCALES.ZH_HANT];

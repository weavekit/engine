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

const canonicalByLower = new Map<string, Locale>(
  SUPPORTED_LOCALES.map((tag) => [tag.toLowerCase(), tag]),
);

function matchLocaleTag(raw: string): Locale | undefined {
  const tag = raw.trim().toLowerCase();
  if (tag === '' || tag === '*') return undefined;
  const exact = canonicalByLower.get(tag);
  if (exact !== undefined) return exact;
  if (tag.startsWith('zh-')) {
    if (/(?:^|-)hant(?:-|$)/.test(tag) || /-(?:tw|hk|mo)(?:-|$)/.test(tag)) return LOCALES.ZH_HANT;
    if (/(?:^|-)hans(?:-|$)/.test(tag) || /-(?:cn|sg|my)(?:-|$)/.test(tag)) return LOCALES.ZH;
  }
  const base = tag.split('-')[0];
  return base === undefined ? undefined : canonicalByLower.get(base);
}

/**
 * Resolve a request locale from an `Accept-Language` header. Entries are ordered
 * by q-value, then exact tags win over base-language matches (`pt-BR` → `pt`).
 * `zh-CN`/`zh-SG` map to `zh`; `zh-TW`/`zh-HK`/`zh-MO`/`zh-Hant-*` map to
 * `zh-Hant`. Unknown tags and `*` are ignored.
 */
export function negotiateLocale(
  header: string | readonly string[] | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? header.join(',') : '';
  if (raw.trim() === '') return fallback;
  const entries = raw
    .split(',')
    .map((entry, index) => {
      const [tag = '', ...params] = entry.trim().split(';');
      let q = 1;
      for (const param of params) {
        const [name, value] = param.trim().split('=');
        if (name?.toLowerCase() !== 'q') continue;
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
      return { tag: tag.trim(), q, index };
    })
    .filter((entry) => entry.tag !== '' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of entries) {
    const matched = matchLocaleTag(entry.tag);
    if (matched !== undefined) return matched;
  }
  return fallback;
}

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

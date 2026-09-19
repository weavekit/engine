import { translate, DEFAULT_LOCALE } from '../i18n/index.js';
import type { Locale, MessageKey } from '../i18n/index.js';

/**
 * Localized validation error.
 *
 * Carries a message catalog key + interpolation params + the locale used to
 * render `message`. Keep `code`/`params` so callers can re-render the message
 * in another locale (see {@link localize}) — e.g. log in English, respond in
 * the request's language.
 */
export class SchemaError extends Error {
  /** message catalog key (see core/i18n/en.ts) */
  readonly code: MessageKey;
  /** interpolation params used to render the message */
  readonly params: Record<string, unknown>;
  /** locale the message was rendered with */
  readonly locale: Locale;

  constructor(code: MessageKey, params: Record<string, unknown> = {}, locale: Locale = DEFAULT_LOCALE) {
    super(translate(code, params, locale));
    this.name = 'SchemaError';
    this.code = code;
    this.params = params;
    this.locale = locale;
  }

  /** re-resolve the message in another locale without losing code/params */
  localize(locale: Locale): string {
    return translate(this.code, this.params, locale);
  }
}

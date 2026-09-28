/**
 * ISO 4217 currency helpers for the `currency` field type. Browser-safe: uses
 * only the global `Intl` (no imports), so it can be consumed from any layer.
 */

/** true when `code` is a currency the runtime recognizes (ISO 4217) */
export function isCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

/** minor-unit fraction digits for a currency (USD=2, JPY=0); falls back to 2 */
export function currencyMinorUnits(code: string): number {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits;
    return typeof digits === 'number' ? digits : 2;
  } catch {
    return 2;
  }
}

import { readFileSync } from 'node:fs';
import { interpolate, negotiateLanguage, type Locale } from '../web/language.js';

export { negotiateLanguage, type Locale };
export type Catalog = Record<'web' | 'mcp' | 'errors', Record<string, string>>;
export const catalogs = Object.fromEntries(
  ['en', 'es'].map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')),
  ]),
) as Record<Locale, Catalog>;

export function translate(
  locale: Locale,
  section: keyof Catalog,
  key: string,
  values: Record<string, string | number> = {},
) {
  const source = catalogs[locale]?.[section];
  const fallback = catalogs.en[section];
  const text =
    source && Object.hasOwn(source, key)
      ? source[key]
      : Object.hasOwn(fallback, key)
        ? fallback[key]
        : key;
  return interpolate(text!, values);
}

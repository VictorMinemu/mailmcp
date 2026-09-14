export type Locale = 'en' | 'es';
export const languages: Locale[];
export function matchLanguage(value: unknown): Locale | undefined;
export function negotiateLanguage(header?: string, fallback?: string): Locale;
export function interpolate(text: string, values?: Record<string, string | number>): string;

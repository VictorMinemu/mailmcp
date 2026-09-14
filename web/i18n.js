import { matchLanguage, negotiateLanguage, interpolate } from './language.js';

let locale = 'en';
const catalogs = new Map();
const bindings = new WeakMap();
const emergency = {
  language_failed: 'The language could not be loaded. Please try again.',
  failed: 'The operation could not be completed.',
};
let changeVersion = 0;
export const language = () => locale;
export const message = (key, values = {}, section = 'web') => ({ key, values, section });
export function t(key, values = {}, section = 'web') {
  const source = catalogs.get(locale)?.[section];
  const fallback = catalogs.get('en')?.[section];
  return interpolate(
    source && Object.hasOwn(source, key)
      ? source[key]
      : fallback && Object.hasOwn(fallback, key)
        ? fallback[key]
        : section === 'web' && Object.hasOwn(emergency, key)
          ? emergency[key]
          : key,
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'number' ? value.toLocaleString(locale) : value,
      ]),
    ),
  );
}
export function setText(element, value) {
  if (value && typeof value === 'object' && 'key' in value) {
    bindings.set(element, value);
    element.dataset.localized = '';
    element.textContent = t(value.key, value.values, value.section);
  } else {
    bindings.delete(element);
    delete element.dataset.localized;
    element.textContent = value;
  }
}
export class UiError extends Error {
  constructor(key, section = 'web') {
    super(t(key, {}, section));
    this.localized = message(key, {}, section);
  }
}
export function applyLanguage() {
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  for (const attr of ['aria-label', 'placeholder']) {
    document.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    });
  }
  document.querySelectorAll('[data-localized]').forEach((el) => {
    const value = bindings.get(el);
    if (value) el.textContent = t(value.key, value.values, value.section);
  });
  document.querySelectorAll('[data-date]').forEach((el) => {
    el.textContent = new Date(el.dataset.date).toLocaleString(locale);
  });
  document.querySelectorAll('[data-language-picker]').forEach((el) => {
    el.value = locale;
  });
  document.querySelectorAll('[data-validation-error]').forEach((el) => validateField(el));
}
async function load(locale) {
  if (!catalogs.has(locale)) {
    let response;
    try {
      response = await fetch(`/locales/${locale}.json`);
    } catch {
      throw new UiError('language_failed');
    }
    if (!response.ok) throw new UiError('language_failed');
    catalogs.set(locale, await response.json());
  }
}
export async function changeLanguage(value) {
  const chosen = matchLanguage(value);
  if (!chosen) return;
  const version = ++changeVersion;
  await load(chosen);
  if (version !== changeVersion) return;
  locale = chosen;
  try {
    localStorage.setItem('mailmcp.language', locale);
  } catch {
    /* Storage can be disabled. */
  }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  applyLanguage();
}
export async function initLanguage() {
  let saved;
  try {
    saved = localStorage.getItem('mailmcp.language');
  } catch {
    /* Use browser preferences. */
  }
  const chosen =
    matchLanguage(new URLSearchParams(location.search).get('lang')) ??
    matchLanguage(saved) ??
    negotiateLanguage(navigator.languages?.join(',') ?? navigator.language);
  await load('en');
  await changeLanguage(chosen);
}

export function validateField(field) {
  field.setCustomValidity('');
  delete field.dataset.validationError;
  const validity = field.validity;
  if (!validity.valid) {
    const key = validity.valueMissing
      ? 'required_field'
      : validity.typeMismatch && field.type === 'email'
        ? 'invalid_email'
        : 'invalid_field';
    field.setCustomValidity(t(key));
    field.dataset.validationError = key;
  }
}

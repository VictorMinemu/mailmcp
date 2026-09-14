export const languages = ['en', 'es'];

export function matchLanguage(value) {
  if (typeof value !== 'string') return undefined;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return languages.includes(base) ? base : undefined;
}

export function negotiateLanguage(header, fallback = 'en') {
  const choices = String(header ?? '')
    .slice(0, 4096)
    .split(',')
    .map((entry, order) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const quality = parameters.find((p) => p.trim().startsWith('q='));
      return { tag, order, q: quality ? Number(quality.trim().slice(2)) : 1 };
    })
    .filter(({ q }) => Number.isFinite(q) && q > 0 && q <= 1)
    .sort((a, b) => b.q - a.q || a.order - b.order);
  for (const { tag } of choices) {
    const language = matchLanguage(tag);
    if (language) return language;
  }
  return matchLanguage(fallback) ?? 'en';
}

export function interpolate(text, values = {}) {
  // One pass: user text containing braces is never interpreted a second time.
  return text.replace(/\{([a-zA-Z_]+)\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

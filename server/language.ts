/** The entry for the language set in Settings, else for its parent ("zh-cn" → "zh"), else English. */
export function byLanguage<T>(table: { en: T } & Partial<Record<string, T>>, language: string | undefined): T {
  let candidate = language?.trim().toLowerCase() || "en";
  while (candidate) {
    const entry = table[candidate];
    if (entry !== undefined) return entry;
    const separator = candidate.lastIndexOf("-");
    if (separator < 0) break;
    candidate = candidate.slice(0, separator);
  }
  return table.en;
}

/** The locale dates and times are formatted in: the language set in Settings, else US English. */
export function intlLocale(language: string | undefined): string {
  try {
    return Intl.getCanonicalLocales(language?.trim() || "en-US")[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

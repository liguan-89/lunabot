/** A settings query as the words a result must all contain: "notification sounds" finds a row titled
 * "Notification sounds", which one whole-string substring test does not. */
export function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every word of `query` appears in at least one of `parts`, ignoring case. No query matches everything. */
export function matchesWords(parts: readonly string[], query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const haystack = parts.map((part) => part.toLowerCase());
  return words.every((word) => haystack.some((part) => part.includes(word)));
}

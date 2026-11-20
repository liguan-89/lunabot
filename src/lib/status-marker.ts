// The first translation of the `server.firstReply.*` lines wrote the marker into
// the sentence ("提示：…", "Hinweis: …"), and rows stored in that window still
// carry it. A stored row's marker is in the conversation's language, never the
// wire word, so every reader that startsWith("notice:") skips it. Recognize the
// shipped prefixes on read; writing always uses the wire marker.
const LEGACY_NOTICE_PREFIXES = ["提示：", "提示:", "Hinweis：", "Hinweis:"] as const;

/** A stored row's notice words, or null when it is not a legacy notice. */
export function legacyNoticeBody(name: string): string | null {
  const prefix = LEGACY_NOTICE_PREFIXES.find((marker) => name.startsWith(marker));
  return prefix ? name.slice(prefix.length).trim() : null;
}

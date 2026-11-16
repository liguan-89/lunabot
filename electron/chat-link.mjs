// lunabot://thread/<thread-id>?bot=<bot-id>, lunabot://bot/<bot-id> and lunabot://task?bot=<bot-id>&text=<text>.
// Links written before the rename (dexbot://, openmausbot://) still open; only the new scheme is ever written.
// The page checks them strictly against its chats; opening one never sends, interrupts or creates anything —
// a task link only drafts the text in the bot's composer.
const CHAT_LINK_PATHS = ["thread/", "bot/", "task"];
const SCHEMES = ["lunabot://", "dexbot://", "openmausbot://"];
const MAX_LINK_LENGTH = 1024;

export function chatLinkFrom(value) {
  const link = typeof value === "string" ? value.trim() : "";
  if (link.length > MAX_LINK_LENGTH) return null;
  const lower = link.toLowerCase();
  return SCHEMES.some((scheme) => CHAT_LINK_PATHS.some((path) => lower.startsWith(scheme + path))) ? link : null;
}

export function chatLinkFromCommandLine(argv) {
  for (const value of argv) {
    const link = chatLinkFrom(value);
    if (link) return link;
  }
  return null;
}

// Outbound actions: calls that reach a person outside the app or move money.
// Below Full access they get their own confirmation unless the bot's rule sends
// without asking; at Full access they run unless the bot has a rule of its own.
// A read-and-draft routine run never reaches them: the relay refuses every send
// there. Shared by the harness (which enforces it) and the app.
import { isConnectedAppsServer } from "./own-apps.ts";

export type OutboundPolicy = {
  /** ask: every outbound call waits for a tap. allow: outbound calls go out without asking. */
  policy: "ask" | "allow";
};

/** Tools whose action is one of these words send something somewhere. */
const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
  "BUY",
  "PURCHASE",
  "DIAL",
]);

/** Creating one of these is sending it: a created comment is a comment
 * someone reads, a created invoice is one someone receives, a created call rings someone. */
const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW", "MAKE"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM", "CALL"]);

/** Telnyx's hosted server reaches its whole API through one tool, so any call of it may ring, text or buy. */
const RAW_API_ACTION = /^mcp__.+__invoke_api_endpoint$/;

/** A read verb first means the rest of the name is what is being read:
 * REDDIT_GET_POST fetches a post, it does not post. */
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** Composio reads known by slug, since some put the noun first (GOOGLECALENDAR_EVENTS_LIST lists events). */
export const KNOWN_READ_SLUGS: ReadonlySet<string> = new Set([
  "GMAIL_FETCH_EMAILS",
  "GMAIL_GET_PROFILE",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FIND_EVENT",
  "GOOGLECALENDAR_LIST_CALENDARS",
  // The phone's screen observation reads, though its verb hides behind the UI token.
  "PHONE_UI_OBSERVE",
  // Waiting changes nothing on the phone; it only lets the screen settle.
  "PHONE_UI_WAIT",
  // A screenshot and its text recognition only read the screen.
  "PHONE_UI_SCREENSHOT",
  "PHONE_UI_OCR",
  // Querying the screen's elements reads the same tree observation does, though neither of its tokens is a read verb.
  "PHONE_UI_QUERY",
  // Listing the apps with a launcher entry only reads the phone's own list.
  "PHONE_LIST_APPS",
  // Reading the clipboard only reads; writing it is a phone-wide side effect and asks first.
  "PHONE_CLIPBOARD_GET",
  // Listing recent notifications only reads what the person already let this app see.
  "PHONE_NOTIF_LIST",
  // Listing and reading the phone's allowed files only reads; putting one in the chat does too.
  "PHONE_FILE_LIST",
  "PHONE_FILE_READ",
  "PHONE_FILE_SEND",
]);

/** Driving the phone's screen reaches every app on it, so each control but observing and waiting sends something
 * somewhere and asks the person first, like any outbound call. The Clock app's own alarm and timer intents, a link
 * opened on the controlled display and text handed to another app's compose screen are phone-wide side effects too;
 * so is choosing whether the app a task drove stays open or is finished when the task ends.
 *
 * PHONE_UI_FIND is a write here even though it only reads: it scrolls the screen looking for a target, which is the
 * same side effect PHONE_UI_SCROLL has, and the person is asked before the phone moves. */
const PHONE_UI_WRITES: ReadonlySet<string> = new Set([
  "PHONE_UI_COLLECT", "PHONE_UI_FIND", "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL",
  "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK", "PHONE_UI_RUN", "PHONE_CLIPBOARD_SET", "PHONE_FILE_SHARE",
  "PHONE_SET_ALARM", "PHONE_SET_TIMER", "PHONE_OPEN_LINK", "PHONE_SHARE_TEXT", "PHONE_UI_AFTER_TASK",
]);

/** One of the phone-screen controls (never PHONE_UI_OBSERVE); accepts the MCP-shaped `mcp__device__…` name too. */
export function isPhoneUiWrite(name: string): boolean {
  return PHONE_UI_WRITES.has(name.replace(/^mcp__(?:composio|own_apps|device)__/, ""));
}

/** The action part of a tool name, as upper-case word tokens. Composio's
 * TOOLKIT_ACTION drops its toolkit; an MCP server's mcp__server__action
 * drops its server; a bare built-in like Bash stays as it is. */
function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    action = rest.join("_");
    if (isConnectedAppsServer(server)) return actionTokens(action);
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Does the tool name describe a read-only action? This is deliberately
 * narrower than "not outbound": updates, deletes and other writes do not
 * become reads merely because they send nothing to another person. */
export function isReadOnlyTool(name: string): boolean {
  if (KNOWN_READ_SLUGS.has(name.replace(/^mcp__(?:composio|own_apps|device)__/, ""))) return true;
  const tokens = actionTokens(name);
  return tokens.length > 0 && READ_VERBS.has(tokens[0]);
}

/** The built-in agents server's X research tools only read X: x_post reads a post, it does not post one. */
const AGENTS_X_READS = /^(?:mcp__agents__|agents__|agents_)?x_(?:search|user_posts|post|profile)$/;

/** Does this tool send something to someone, or move money? */
export function isOutboundTool(name: string): boolean {
  // A raw API call from the workbench can do anything an app tool can, and
  // nothing here can read which; it is treated as a send.
  if (name === "COMPOSIO_PROXY_EXECUTE" || RAW_API_ACTION.test(name)) return true;
  if (AGENTS_X_READS.test(name)) return false;
  if (isPhoneUiWrite(name)) return true;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (isReadOnlyTool(name)) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

/** The stored shape, or null when the value is not one. Fields other than `policy` are dropped. */
export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { policy } = value as { policy?: unknown };
  return policy === "ask" || policy === "allow" ? { policy } : null;
}

/** What a bot without a stored policy does: ask, every time. */
export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask" };

/** The rule a send goes out under: its own, or at Full access with none saved, allow (the "Send without asking"
 * the UI and the hold both show). */
export function effectiveOutboundPolicy(rule: OutboundPolicy | undefined, fullAccess: boolean): OutboundPolicy {
  return rule ?? (fullAccess ? { policy: "allow" } : DEFAULT_OUTBOUND_POLICY);
}

/** Drops from a stored bot's rule what `normalizeOutboundPolicy` drops, so every copy of one rule reads the same; true
 * when it changed. A rule that is not one is left as it is, and asks. */
export function trimOutboundPolicy(bot: { outbound?: OutboundPolicy }): boolean {
  const kept = bot.outbound && normalizeOutboundPolicy(bot.outbound);
  if (!kept || Object.keys(bot.outbound!).length === Object.keys(kept).length) return false;
  bot.outbound = kept;
  return true;
}

/** One app tool a connector request would run, with its arguments when the
 * request carries them. */
export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Composio's session exposes a handful of meta tools and runs the app
 * tools inside them: a multi-execute call carries a list of slugs with
 * arguments. Arbitrary workbench/bash code is opaque: it requires an
 * explicit unrestricted approval, never an inferred app or send count.
 * Search, schema lookup, and connection management run no app tools. */
export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = isRecord(args) && Array.isArray(args.tools) ? args.tools
      : isRecord(args) && typeof args.tool_slug === "string" ? [args] : [];
    if (!tools.length) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
    const calls: ConnectorCall[] = [];
    for (const item of tools) {
      if (!isRecord(item)) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      const slug = [item.tool_slug, item.slug, item.name, item.tool].find((value) => typeof value === "string" && value);
      if (typeof slug !== "string") return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      calls.push({ slug, ...(item.arguments !== undefined ? { arguments: item.arguments } : {}) });
    }
    return calls;
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL") {
    // Arbitrary code can compute tool names and repeat calls. Its app and
    // outbound count cannot be inferred from literals in the source.
    return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  }
  if (["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"].includes(name)) return [];
  if (name.startsWith("COMPOSIO_")) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  return [{ slug: name, ...(args !== undefined ? { arguments: args } : {}) }];
}

/** The subset of a request's app tools that would send something. */
export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}

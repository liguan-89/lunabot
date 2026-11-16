// Vocabulary for "phone apps as bot tools": the apps a paired phone may allow,
// per-bot grants, and the PHONE_* tool names served by the `device` MCP server.
import { isReadOnlyAction } from "./connector-scopes.ts";

export const PHONE_CAPABILITIES = ["calendar", "reminders", "contacts", "location", "home", "messages", "phoneUi", "phoneData"] as const;
export type PhoneCapability = (typeof PHONE_CAPABILITIES)[number];
export type PhoneGrant = "read" | "write";
/** Per-bot grant; an absent key is off. */
export type PhoneApps = Partial<Record<PhoneCapability, PhoneGrant>>;
/** The apps every bot could use before the screen tools existed: a bot with no phoneApps grant keeps getting only these,
 * never phoneUi or phoneData. */
export const DEFAULT_PHONE_CAPABILITIES = PHONE_CAPABILITIES.filter(
  (cap) => cap !== "phoneUi" && cap !== "phoneData",
) as readonly Exclude<PhoneCapability, "phoneUi" | "phoneData">[];

export const PHONE_SLUG = "phone";
export const PHONE_MCP_SERVER = "device";
export const PHONE_PLATFORMS = ["ios", "android"] as const;
export type PhonePlatform = (typeof PHONE_PLATFORMS)[number];

export const PHONE_TOOL_NAMES = [
  "PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE",
  "PHONE_LIST_REMINDERS", "PHONE_CREATE_REMINDER", "PHONE_UPDATE_REMINDER", "PHONE_COMPLETE_REMINDER", "PHONE_DELETE_REMINDER",
  "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_CREATE_CONTACT", "PHONE_UPDATE_CONTACT",
  "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY",
  "PHONE_LIST_HOME", "PHONE_SET_ACCESSORY", "PHONE_RUN_SCENE",
  "PHONE_SEND_MESSAGE", "PHONE_SEND_WHATSAPP",
  "PHONE_UI_OBSERVE", "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL",
  "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK", "PHONE_UI_RUN", "PHONE_UI_WAIT", "PHONE_UI_SCREENSHOT", "PHONE_UI_OCR",
  "PHONE_UI_QUERY", "PHONE_LIST_APPS",
  "PHONE_CLIPBOARD_GET", "PHONE_CLIPBOARD_SET", "PHONE_NOTIF_LIST", "PHONE_FILE_LIST", "PHONE_FILE_READ",
  "PHONE_FILE_SEND", "PHONE_FILE_SHARE",
  "PHONE_SET_ALARM", "PHONE_SET_TIMER", "PHONE_OPEN_LINK", "PHONE_SHARE_TEXT",
] as const;
export type PhoneToolName = (typeof PHONE_TOOL_NAMES)[number];

const TOOL_CAPABILITY: Record<PhoneToolName, PhoneCapability> = {
  PHONE_LIST_EVENTS: "calendar", PHONE_GET_EVENT: "calendar", PHONE_FIND_FREE_TIME: "calendar", PHONE_CREATE_EVENT: "calendar",
  PHONE_UPDATE_EVENT: "calendar", PHONE_DELETE_EVENT: "calendar", PHONE_RESPOND_TO_INVITE: "calendar",
  PHONE_LIST_REMINDERS: "reminders", PHONE_CREATE_REMINDER: "reminders", PHONE_UPDATE_REMINDER: "reminders",
  PHONE_COMPLETE_REMINDER: "reminders", PHONE_DELETE_REMINDER: "reminders",
  PHONE_SEARCH_CONTACTS: "contacts", PHONE_GET_CONTACT: "contacts", PHONE_CREATE_CONTACT: "contacts", PHONE_UPDATE_CONTACT: "contacts",
  PHONE_GET_LOCATION: "location", PHONE_FIND_PLACES_NEARBY: "location",
  PHONE_LIST_HOME: "home", PHONE_SET_ACCESSORY: "home", PHONE_RUN_SCENE: "home",
  PHONE_SEND_MESSAGE: "messages", PHONE_SEND_WHATSAPP: "messages",
  PHONE_UI_OBSERVE: "phoneUi", PHONE_UI_LAUNCH: "phoneUi", PHONE_UI_TAP: "phoneUi",
  PHONE_UI_TAP_AT: "phoneUi", PHONE_UI_TYPE: "phoneUi", PHONE_UI_SCROLL: "phoneUi", PHONE_UI_SWIPE: "phoneUi",
  PHONE_UI_KEY: "phoneUi", PHONE_UI_BACK: "phoneUi", PHONE_UI_RUN: "phoneUi", PHONE_UI_WAIT: "phoneUi",
  PHONE_UI_SCREENSHOT: "phoneUi", PHONE_UI_OCR: "phoneUi",
  PHONE_UI_QUERY: "phoneUi", PHONE_LIST_APPS: "phoneUi",
  PHONE_CLIPBOARD_GET: "phoneUi", PHONE_CLIPBOARD_SET: "phoneUi", PHONE_NOTIF_LIST: "phoneData",
  PHONE_FILE_LIST: "phoneData", PHONE_FILE_READ: "phoneData", PHONE_FILE_SEND: "phoneData", PHONE_FILE_SHARE: "phoneUi",
  PHONE_SET_ALARM: "phoneUi", PHONE_SET_TIMER: "phoneUi", PHONE_OPEN_LINK: "phoneUi", PHONE_SHARE_TEXT: "phoneUi",
};

export function isPhoneToolName(name: unknown): name is PhoneToolName {
  return typeof name === "string" && Object.hasOwn(TOOL_CAPABILITY, name);
}

export function phoneToolCapability(name: PhoneToolName): PhoneCapability {
  return TOOL_CAPABILITY[name];
}

/** GET/LIST/SEARCH/FIND read; everything else writes (isReadOnlyAction(name, "phone")). */
export function isPhoneWrite(name: string): boolean {
  return !isReadOnlyAction(name, PHONE_SLUG);
}

export function phoneToolSends(name: string): boolean {
  return name.startsWith("PHONE_SEND_");
}

/** Unknown key or value → null; `{}` is valid (everything off). */
export function normalizePhoneApps(value: unknown): PhoneApps | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: PhoneApps = {};
  for (const [key, grant] of Object.entries(value)) {
    if (!(PHONE_CAPABILITIES as readonly string[]).includes(key)) return null;
    if (grant !== "read" && grant !== "write") return null;
    out[key as PhoneCapability] = grant;
  }
  return out;
}

/** What a bot with no phoneApps grant gets: every legacy app, read and write, and never phoneUi. */
export const ALL_PHONE_APPS: PhoneApps = Object.fromEntries(DEFAULT_PHONE_CAPABILITIES.map((c) => [c, "write"])) as PhoneApps;

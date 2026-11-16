// The phone tools the `device` MCP server lists: small flat inputs validated against their advertised schema.
import type { ValidateFunction } from "ajv";

import { PHONE_TOOL_NAMES, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";

const ID = { type: "string", minLength: 1, maxLength: 256, description: "An id from an earlier result." };
const TEXT = (maxLength: number, description?: string) => ({ type: "string", maxLength, ...(description ? { description } : {}) });
const DATE = (what: string) => TEXT(64, `${what}, ISO 8601 with offset, e.g. 2026-10-24T12:00:00+05:30.`);
const LIST = (description: string) => ({ type: "array", maxItems: 20, description, items: { type: "string", minLength: 1, maxLength: 320 } });
const PHONE = TEXT(100, "Which phone, by name, when more than one is paired. Default: the one used most recently.");

interface PhoneTool {
  name: PhoneToolName;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const tool = (name: PhoneToolName, description: string, properties: Record<string, unknown>, required: string[] = []): PhoneTool =>
  ({ name, description, inputSchema: { type: "object", properties: { ...properties, phone: PHONE }, required, additionalProperties: false } });

const EVENT_FIELDS = {
  title: TEXT(500, "Event title."), start: DATE("Start"), end: DATE("End"), allDay: { type: "boolean", description: "An all-day event." },
  location: TEXT(500, "Where it takes place."), notes: TEXT(5000, "Notes."), attendees: LIST("Attendee emails or names."),
};
const CONTACT_FIELDS = {
  givenName: TEXT(200, "First name."), familyName: TEXT(200, "Last name."), phones: LIST("Phone numbers with country code."),
  emails: LIST("Email addresses."), organization: TEXT(200, "Company."), notes: TEXT(5000, "Notes."),
};
const REF = TEXT(64, "An element ref from PHONE_UI_OBSERVE results. Refs are opaque and go stale when the screen changes; observe again first.");

const tools: PhoneTool[] = [
  tool("PHONE_LIST_EVENTS", "List calendar events on the phone between two times, optionally for one calendar. Read only.", { from: DATE("Range start"), to: DATE("Range end"), calendar: TEXT(200, "Calendar name.") }, ["from", "to"]),
  tool("PHONE_GET_EVENT", "Read one calendar event by id. Read only.", { id: ID }, ["id"]),
  tool("PHONE_FIND_FREE_TIME", "Find gaps of at least the given length in the person's calendar between two times. Read only.", { from: DATE("Range start"), to: DATE("Range end"), minutes: { type: "integer", minimum: 5, maximum: 1440, description: "Shortest gap wanted, in minutes." } }, ["from", "to", "minutes"]),
  tool("PHONE_CREATE_EVENT", "Add an event to the phone's calendar. Check for conflicts first with PHONE_LIST_EVENTS.", EVENT_FIELDS, ["title", "start", "end"]),
  tool("PHONE_UPDATE_EVENT", "Change an existing event; only the fields given change.", { id: ID, ...EVENT_FIELDS }, ["id"]),
  tool("PHONE_DELETE_EVENT", "Delete a calendar event by id.", { id: ID }, ["id"]),
  tool("PHONE_RESPOND_TO_INVITE", "Accept, decline or tentatively accept a calendar invitation.", { id: ID, response: { type: "string", enum: ["accept", "decline", "tentative"] } }, ["id", "response"]),
  tool("PHONE_LIST_REMINDERS", "List reminders, optionally for one list, a due date range, or only completed ones. Read only.", { list: TEXT(200, "Reminder list name."), from: DATE("Due on or after"), to: DATE("Due on or before"), completed: { type: "boolean", description: "True for completed reminders only; default is open ones." } }),
  tool("PHONE_CREATE_REMINDER", "Add a reminder, optionally with a due time and a list.", { title: TEXT(500, "What to be reminded of."), due: DATE("Due"), notes: TEXT(5000, "Notes."), list: TEXT(200, "Reminder list name.") }, ["title"]),
  tool("PHONE_UPDATE_REMINDER", "Change a reminder's title, due time or notes; only the fields given change.", { id: ID, title: TEXT(500, "New title."), due: DATE("New due time"), notes: TEXT(5000, "New notes.") }, ["id"]),
  tool("PHONE_COMPLETE_REMINDER", "Mark a reminder done.", { id: ID }, ["id"]),
  tool("PHONE_DELETE_REMINDER", "Delete a reminder by id.", { id: ID }, ["id"]),
  tool("PHONE_SEARCH_CONTACTS", "Search the phone's contacts by name, number, email or company. Returns contacts with ids. Read only.", { query: TEXT(200, "Free text to match.") }, ["query"]),
  tool("PHONE_GET_CONTACT", "Read one contact by id, with numbers and emails. Read only.", { id: ID }, ["id"]),
  tool("PHONE_CREATE_CONTACT", "Add a contact. Search first so you do not create a duplicate.", CONTACT_FIELDS, ["givenName"]),
  tool("PHONE_UPDATE_CONTACT", "Change a contact; only the fields given change.", { id: ID, ...CONTACT_FIELDS }, ["id"]),
  tool("PHONE_GET_LOCATION", "Where the phone is right now: coordinates and a place name. Read only.", {}),
  tool("PHONE_FIND_PLACES_NEARBY", "Find places near the phone, such as a cafe or a pharmacy. Read only.", { query: TEXT(200, "What to look for."), radiusMeters: { type: "integer", minimum: 50, maximum: 50000, description: "Search radius in meters." } }, ["query"]),
  tool("PHONE_LIST_HOME", "List the home's accessories, their current state and the scenes. Read only.", {}),
  tool("PHONE_SET_ACCESSORY", "Set one characteristic of a home accessory, such as turning a light on or setting a thermostat.", { accessoryId: ID, characteristic: TEXT(100, "Characteristic name from PHONE_LIST_HOME, e.g. power."), value: { type: ["string", "number", "boolean"], description: "The new value." } }, ["accessoryId", "characteristic", "value"]),
  tool("PHONE_RUN_SCENE", "Run a home scene by id.", { sceneId: ID }, ["sceneId"]),
  tool("PHONE_SEND_MESSAGE", "Prepare a text message. It opens a sheet on the phone and is sent only when the person taps Send.", { to: TEXT(200, "Contact name or phone number."), text: { type: "string", minLength: 1, maxLength: 4000 } }, ["to", "text"]),
  tool("PHONE_SEND_WHATSAPP", "Prepare a WhatsApp message. It opens a sheet on the phone and is sent only when the person taps Send.", { to: TEXT(200, "Contact name or phone number."), text: { type: "string", minLength: 1, maxLength: 4000 } }, ["to", "text"]),
  tool("PHONE_UI_OBSERVE", "Read the phone's current screen as a short text description with opaque element refs, one screen at a time. Read only; no screenshots. Observe before a step; every driving action also returns the screen as it is afterwards, so read that instead of observing again. Never guess a ref.", {}),
  tool("PHONE_UI_COLLECT", "Read several screens in one call: the text of the current screen, then one scroll and the next, for a long list or a chat history. A line already returned is not repeated, and the read stops at the end of the list or when the app changes. It scrolls, so it asks the person first like any other screen write.", {
    direction: { type: "string", enum: ["up", "down"], description: "Where the content moves, as PHONE_UI_SCROLL takes it: down follows the list to newer content below, up back towards older content above. The finger travels the other way." },
    pages: { type: "integer", minimum: 1, maximum: 20, description: "Most screens to read; default 8." },
    maxLines: { type: "integer", minimum: 1, maximum: 1000, description: "Most text lines to return; default 300." },
    fromY: { type: "integer", minimum: 0, maximum: 999, description: "Top of the band to read, 0 at the controlled display's top edge and 999 at its bottom, the same display element bounds use; default 50." },
    toY: { type: "integer", minimum: 0, maximum: 999, description: "Bottom of the band to read, 0 at the controlled display's top edge and 999 at its bottom; default 950." },
  }, ["direction"]),
  tool("PHONE_UI_QUERY", "Find elements of the phone's current screen by text, view id or role, at least one of the three, when the full element list is too long; its refs work with PHONE_UI_TAP and PHONE_UI_TYPE. Read only.", {
    text: TEXT(200, "Case-insensitive text or content description to find."),
    resourceId: TEXT(200, "Full or partial Android view id to find."),
    role: TEXT(100, "Full or partial accessibility class or role to find."),
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Most elements to return; default 30." },
  }),
  tool("PHONE_LIST_APPS", "List the apps installed on the phone that have a launcher entry, so PHONE_UI_LAUNCH gets the real package name instead of a guess. Read only.", { query: TEXT(120, "Part of an app name or package name to match."), limit: { type: "integer", minimum: 1, maximum: 200, description: "Most apps to return; default 60." } }),
  tool("PHONE_UI_LAUNCH", "Open one app on the person's Android phone by its package name, as an earlier PHONE_UI_OBSERVE named it.", { app: TEXT(200, "The Android app's package name.") }, ["app"]),
  tool("PHONE_UI_TAP", "Tap one element of the phone's current screen by its ref from PHONE_UI_OBSERVE. When the element's own click does nothing, the phone taps its spot and then the smallest clickable element under it; send, pay, delete, confirm and toggle controls are never retried.", { ref: REF }, ["ref"]),
  tool("PHONE_UI_TAP_AT", "Tap a pixel point on the phone's screen, for screens no element describes (an image, a canvas, a game). Coordinates use the controlled display's pixels, the same system as element bounds and OCR line boxes.", { x: { type: "integer", minimum: 0, maximum: 10000, description: "Horizontal pixel position." }, y: { type: "integer", minimum: 0, maximum: 10000, description: "Vertical pixel position." } }, ["x", "y"]),
  tool("PHONE_UI_TYPE", "Type text into the editable element named by ref from the latest PHONE_UI_OBSERVE result. Password fields are never accepted. Fields that refuse direct text get plain-ASCII key events instead; other text is refused rather than typed as something else.", { text: { type: "string", minLength: 1, maxLength: 2000, description: "What to type, submitted as it is." }, ref: REF }, ["text", "ref"]),
  tool("PHONE_UI_SCROLL", "Scroll the phone's current screen, or the element named by ref, one step up or down. Falls back to a real swipe when the list ignores the scroll action.", { direction: { type: "string", enum: ["up", "down"], description: "Where the content moves." }, ref: REF }, ["direction"]),
  tool("PHONE_UI_SWIPE", "Swipe one finger across the phone's whole screen, for screens that ignore a scroll action: carousels, sheets, short-video feeds. The finger travels in `direction`, so swiping up scrolls the content down.", { direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Where the finger moves." } }, ["direction"]),
  tool("PHONE_UI_KEY", "Press one navigation key on the phone, such as enter to submit a search or del to clear a field.", { key: { type: "string", enum: ["back", "enter", "del", "tab", "up", "down", "left", "right"], description: "Which key." } }, ["key"]),
  tool("PHONE_UI_BACK", "Go back one screen on the phone.", {}),
  tool("PHONE_UI_RUN", "Run an ordered list of screen commands on the phone's screen in one call, for a form, a search or a fixed flow whose steps are already known. Each target is found again on the current screen before it acts, and the run stops at the first step that fails, returning the screen it ended on.", {
    commands: {
      type: "array", minItems: 1, maxItems: 20, description: "The steps, in the order to run them.",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["launch", "tap", "type", "scroll", "swipe", "key", "back", "wait", "assert", "observe"], description: "What to do." },
          app: TEXT(200, "The Android app's package name, for launch."),
          ref: TEXT(64, "An element ref from an earlier observe, for a target known exactly; each step still finds it again on the current screen."),
          text: TEXT(2000, "For tap, the visible text of the target; for type, what to type; for assert, the text that must be present."),
          resourceId: TEXT(200, "Full or partial Android view id of the target."),
          role: TEXT(100, "Full or partial accessibility class or role of the target."),
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Where the finger moves, for scroll and swipe." },
          key: { type: "string", enum: ["back", "enter", "del", "tab", "up", "down", "left", "right"], description: "Which key, for key." },
          timeoutMs: { type: "integer", minimum: 300, maximum: 6000, description: "Longest wait in milliseconds, for wait." },
          present: { type: "boolean", description: "For assert: true when the text must be present, false when it must be absent." },
          pressEnter: { type: "boolean", description: "For type: press enter after typing." },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  }, ["commands"]),
  tool("PHONE_UI_WAIT", "Wait for the phone's screen to change, or to stop changing, before deciding the next step. Read only.", { mode: { type: "string", enum: ["change", "settle"], description: "change waits for any change; settle waits for the screen to stop." }, timeoutMs: { type: "integer", minimum: 300, maximum: 6000, description: "Longest wait in milliseconds." } }),
  tool("PHONE_UI_SCREENSHOT", "Take a JPEG of the phone's screen, for anything the element list cannot describe. Also returns the elements of the same moment with their refs. Read only.", {}),
  tool("PHONE_UI_OCR", "Recognize the text on the phone's screen and return it line by line with each line's box, for image or canvas screens the element list cannot describe. Read only.", { maxLines: { type: "integer", minimum: 1, maximum: 200, description: "Longest list of lines to keep." } }),
  tool("PHONE_CLIPBOARD_GET", "Read the phone's clipboard as plain text. Read only.", {}),
  tool("PHONE_CLIPBOARD_SET", "Replace the phone's clipboard with text, for pasting a long value into a field. Asks the person first.", { text: { type: "string", minLength: 1, maxLength: 4000, description: "The text to place on the clipboard." } }, ["text"]),
  tool("PHONE_NOTIF_LIST", "List the last notifications other apps posted on the phone, newest first. Answers only while the person has granted notification access. Read only.", { package: TEXT(200, "Only this Android package's notifications."), limit: { type: "integer", minimum: 1, maximum: 20, description: "How many to return." }, sinceMinutes: { type: "integer", minimum: 1, maximum: 1440, description: "Only notifications from this many minutes ago." } }),
  tool("PHONE_FILE_LIST", "List files the person allowed this bot to see: gallery photos and files in the one folder they granted. Answers only while the file switch is on. Read only.", { query: TEXT(120, "Part of a file name to match."), kind: { type: "string", enum: ["any", "image", "document"], description: "Photos only, the granted folder only, or both." }, limit: { type: "integer", minimum: 1, maximum: 12, description: "How many to return." } }),
  tool("PHONE_FILE_READ", "Read one file by fileId from PHONE_FILE_LIST: an image comes back as a picture, a text file as text, and a PDF as recognized text from its first pages. Read only.", { fileId: TEXT(200, "A fileId from PHONE_FILE_LIST."), pages: { type: "integer", minimum: 1, maximum: 5, description: "PDF pages to read." } }, ["fileId"]),
  tool("PHONE_FILE_SEND", "Put one phone file into this conversation so the person can open it there; the file itself travels to the computer, not through the bot's own hands. Read only.", { fileId: TEXT(200, "A fileId from PHONE_FILE_LIST.") }, ["fileId"]),
  tool("PHONE_FILE_SHARE", "Hand one file to another app's share screen, opened on the phone's controlled display with the file already attached. Name the app that should receive it, or leave the package out to get the system chooser there. Asks the person first.", { fileId: TEXT(200, "A fileId from PHONE_FILE_LIST."), package: TEXT(200, "The Android package that should receive the file.") }, ["fileId"]),
  tool("PHONE_SET_ALARM", "Set an alarm with the phone's own Clock app, which records it without showing its editor. Prefer this over driving the Clock app's screens. Asks the person first.", {
    hour: { type: "integer", minimum: 0, maximum: 23, description: "Hour of the day, 24-hour clock." },
    minute: { type: "integer", minimum: 0, maximum: 59, description: "Minute of the hour." },
    label: TEXT(200, "What the alarm is for, shown when it rings."),
    days: { type: "array", maxItems: 7, description: "Repeat days; leave them out for a one-time alarm.", items: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] } },
    vibrate: { type: "boolean", description: "Vibrate when it rings." },
  }, ["hour", "minute"]),
  tool("PHONE_SET_TIMER", "Start a countdown timer with the phone's own Clock app, which starts it without showing its editor. Prefer this over driving the Clock app's screens. Asks the person first.", {
    seconds: { type: "integer", minimum: 1, maximum: 86400, description: "How long the timer runs, in seconds." },
    label: TEXT(200, "What the timer is for."),
  }, ["seconds"]),
  tool("PHONE_OPEN_LINK", "Open a web link on the phone's controlled display, in the browser or in the named app. Only http and https links are accepted. Asks the person first.", {
    url: TEXT(2000, "The link to open, http or https."),
    app: TEXT(200, "The Android package that should open it; leave it out for the browser."),
  }, ["url"]),
  tool("PHONE_SHARE_TEXT", "Put text into another app's compose screen on the phone's controlled display, with the app named or the system chooser left to pick; the person still sends it. Asks the person first.", {
    text: { type: "string", minLength: 1, maxLength: 5000, description: "The text to place in the other app." },
    app: TEXT(200, "The Android package that should receive the text."),
  }, ["text"]),
  tool("PHONE_UI_AFTER_TASK", "Choose what happens to the app this task drove when the task ends: keep leaves it running in the background on its last page, close finishes it. The choice holds for the rest of the task. Asks the person first.", {
    action: { type: "string", enum: ["keep", "close"], description: "keep leaves the app running in the background; close finishes it." },
    app: TEXT(200, "The Android package to act on; leave it out for the app the task last drove."),
  }, ["action"]),
];

/** Catalog in PHONE_TOOL_NAMES order. */
export const PHONE_TOOLS: ReadonlyArray<PhoneTool> = PHONE_TOOL_NAMES.map((name) => tools.find((t) => t.name === name)!);

let validators: Map<string, ValidateFunction> | undefined;

/** PHONE_UI_QUERY needs one of these; none is required on its own, so the schema cannot say it. */
const QUERY_SELECTORS = ["text", "resourceId", "role"] as const;

export function phoneToolCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(PHONE_TOOLS.map((entry) => [entry.name, compileToolSchema(entry.inputSchema as Record<string, unknown>, { allErrors: true })]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return `Unknown phone tool. Use one of ${PHONE_TOOL_NAMES.join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  if (name === "PHONE_UI_QUERY" && !QUERY_SELECTORS.some((key) => typeof (args as Record<string, unknown>)[key] === "string")) {
    return "PHONE_UI_QUERY needs at least one of text, resourceId, or role.";
  }
  // An inverted band would read nothing at all; the schema cannot say one field must stay under another.
  if (name === "PHONE_UI_COLLECT") {
    const { fromY, toY } = args as { fromY?: unknown; toY?: unknown };
    const top = typeof fromY === "number" ? fromY : 50;
    const bottom = typeof toY === "number" ? toY : 950;
    if (top >= bottom) return "PHONE_UI_COLLECT needs fromY to be smaller than toY.";
  }
  return null;
}

export interface PhoneToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function phoneErrorResult(message: string, extra: Record<string, unknown> = {}): PhoneToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: message, ...extra }, isError: true };
}

/** The phone's `image` (base64) becomes an MCP image block; the rest travels as text, so a reader that only
 * understands text still gets the metadata. The phone last, so no key in the phone's answer can relabel where it ran. */
export function phoneOkResult(result: unknown, phone: { name: string; platform: PhonePlatform }): PhoneToolResult {
  const body = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as object), phone } : { phone, result };
  const record = body as Record<string, unknown>;
  const image = typeof record.image === "string" && typeof record.mimeType === "string" && record.image.length > 0
    ? { data: record.image, mimeType: record.mimeType }
    : null;
  if (!image) return { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record };
  const rest = { ...record };
  delete rest.image;
  const structured = { ...rest, imageBytes: image.data.length };
  return {
    content: [
      { type: "image", data: image.data, mimeType: image.mimeType },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

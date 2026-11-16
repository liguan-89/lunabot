// Structured access to the Mac's own apps (Reminders, Notes, Calendar) for bots: everything runs through
// osascript -l JavaScript (JXA), so the OS's own Automation prompts govern access — Luna Bot asks for no
// extra permission itself. Writes go through the turn's normal approval mode like every other agents tool.
import { execFile } from "node:child_process";

const RUN_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 100;
const TEXT_LIMIT = 200;
const BODY_LIMIT = 4_000;
const DAYS_LIMIT = 31;

export type MacAppName = "reminders" | "notes" | "calendar" | "mail";
export type MacAppAction = "list" | "create" | "complete" | "delete" | "read";

const ACTIONS: Record<MacAppName, MacAppAction[]> = {
  reminders: ["list", "create", "complete", "delete"],
  notes: ["list", "create", "delete"],
  calendar: ["list", "create", "delete"],
  // Sending as the person goes through bot mail; there is deliberately no create here.
  mail: ["list", "read"],
};

export interface MacAppInput {
  app?: unknown;
  action?: unknown;
  title?: unknown;
  body?: unknown;
  calendar?: unknown;
  days?: unknown;
  due?: unknown;
  startsAt?: unknown;
  minutes?: unknown;
}

export type MacAppResult = { ok: true; items?: unknown; name?: string; item?: unknown } | { ok: false; error: string };

const short = (value: unknown, limit = TEXT_LIMIT): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;

const days = (value: unknown): number => {
  const n = typeof value === "number" ? Math.floor(value) : 7;
  return Math.min(Math.max(n, 0), DAYS_LIMIT);
};

// Dates enter the script as epoch milliseconds — never as interpolatable strings.
const dateMs = (value: unknown): number | undefined => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

const minutes = (value: unknown): number => {
  const n = typeof value === "number" ? Math.floor(value) : 60;
  return Math.min(Math.max(n, 5), 43_200);
};

/** The JXA source for one call, or an input error the route answers without spawning. */
export function macAppScript(input: MacAppInput): { script: string } | { error: string } {
  const app = input.app;
  if (app !== "reminders" && app !== "notes" && app !== "calendar" && app !== "mail") {
    return { error: 'mac_apps needs app: "reminders", "notes", "calendar" or "mail"' };
  }
  const action = input.action;
  if (typeof action !== "string" || !(ACTIONS[app] as string[]).includes(action)) {
    return { error: `${app} supports ${ACTIONS[app].join(", ")}` };
  }
  const title = short(input.title);
  const body = typeof input.body === "string" ? input.body.slice(0, BODY_LIMIT) : undefined;
  if (action === "list") {
    if (app === "reminders") {
      return { script: `JSON.stringify(Application("Reminders").defaultList().reminders().slice(0, ${LIST_LIMIT}).map(function (r) { return { name: r.name(), completed: r.completed(), due: r.dueDate() === null ? null : r.dueDate().toISOString() }; }))` };
    }
    if (app === "notes") {
      return { script: `JSON.stringify(Application("Notes").defaultAccount().notes().slice(0, ${LIST_LIMIT}).map(function (n) { return { name: n.name() }; }))` };
    }
    if (app === "mail") {
      // Subjects, senders and dates only — message bodies stay out of model-visible output.
      return { script: `JSON.stringify(Application("Mail").inbox.messages().slice(0, ${LIST_LIMIT}).map(function (m) { return { subject: m.subject(), sender: m.sender(), received: m.dateReceived() === null ? null : m.dateReceived().toISOString(), read: m.readStatus() }; }))` };
    }
    const window = days(input.days);
    return { script: `var start = new Date(); var end = new Date(start.getTime() + ${window} * 86400000); JSON.stringify(Application("Calendar").calendars().reduce(function (all, c) { c.events().forEach(function (e) { var at = e.startDate(); if (at >= start && at <= end) all.push({ summary: e.summary(), calendar: c.name(), start: at.toISOString(), end: e.endDate() === null ? null : e.endDate().toISOString() }); }); return all; }, []).slice(0, ${LIST_LIMIT}))` };
  }
  if (!title) return { error: `${action} needs title` };
  const t = JSON.stringify(title);
  const notFound = title.replace(/"/g, "'");
  if (app === "mail") {
    // read names a message by exact subject and returns its body, bounded like every other text.
    return { script: `var m = Application("Mail").inbox.messages().find(function (m) { return m.subject() === ${t}; }); if (!m) throw new Error("no message with subject ${notFound}"); JSON.stringify({ subject: m.subject(), sender: m.sender(), received: m.dateReceived() === null ? null : m.dateReceived().toISOString(), body: String(m.content()).slice(0, ${BODY_LIMIT}) })` };
  }
  if (app === "reminders") {
    if (action === "complete" || action === "delete") {
      // First name match across all lists; complete skips items already done.
      const done = action === "complete" ? "hit.completed = true" : "app.delete(hit)";
      const pending = action === "complete" ? " && !r.completed()" : "";
      return { script: `var app = Application("Reminders"); var hit; app.lists().some(function (l) { hit = l.reminders().find(function (r) { return r.name() === ${t}${pending}; }); return hit; }); if (!hit) throw new Error("no reminder named ${notFound}"); ${done}; JSON.stringify({ name: ${t} })` };
    }
    const dueMs = input.due === undefined ? undefined : dateMs(input.due);
    if (input.due !== undefined && dueMs === undefined) return { error: "due must be a date string" };
    const extra = `${body ? `, body: ${JSON.stringify(body)}` : ""}${dueMs !== undefined ? `, dueDate: new Date(${dueMs})` : ""}`;
    return { script: `var app = Application("Reminders"); var list = app.defaultList(); var r = app.Reminder({ name: ${t}${extra} }); list.reminders.push(r); JSON.stringify({ name: r.name() })` };
  }
  if (app === "notes") {
    if (action === "delete") {
      return { script: `var app = Application("Notes"); var hit; app.defaultAccount().folders().some(function (f) { hit = f.notes().find(function (n) { return n.name() === ${t}; }); return hit; }); if (!hit) throw new Error("no note named ${notFound}"); app.delete(hit); JSON.stringify({ name: ${t} })` };
    }
    const extra = body ? `, body: ${JSON.stringify(`<div>${body}</div>`)}` : "";
    return { script: `var app = Application("Notes"); var account = app.defaultAccount(); var folders = account.folders(); var folder = folders.length ? folders[0] : account; var n = app.Note({ name: ${t}${extra} }); folder.notes.push(n); JSON.stringify({ name: n.name() })` };
  }
  const calendar = short(input.calendar);
  if (action === "delete") {
    const startsAtMs = input.startsAt === undefined ? undefined : dateMs(input.startsAt);
    if (input.startsAt !== undefined && startsAtMs === undefined) return { error: "startsAt must be a date string" };
    const at = startsAtMs === undefined ? "" : ` && Math.abs(e.startDate().getTime() - ${startsAtMs}) < 60000`;
    return { script: `var app = Application("Calendar"); var hit; app.calendars().some(function (c) { hit = c.events().find(function (e) { return e.summary() === ${t}${at}; }); return hit; }); if (!hit) throw new Error("no event named ${notFound}"); app.delete(hit); JSON.stringify({ name: ${t} })` };
  }
  const extra = body ? `, description: ${JSON.stringify(body)}` : "";
  const pick = calendar
    ? `var cal = Application("Calendar").calendars().find(function (c) { return c.name() === ${JSON.stringify(calendar)}; }); if (!cal) throw new Error("no calendar named ${notFound}");`
    : `var cal = Application("Calendar").calendars()[0]; if (!cal) throw new Error("no calendars");`;
  const startsAtMs = input.startsAt === undefined ? undefined : dateMs(input.startsAt);
  if (input.startsAt !== undefined && startsAtMs === undefined) return { error: "startsAt must be a date string" };
  const startExpr = startsAtMs !== undefined ? `new Date(${startsAtMs})` : "new Date()";
  return { script: `var app = Application("Calendar"); ${pick} var start = ${startExpr}; var e = app.Event({ summary: ${t}, startDate: start, endDate: new Date(start.getTime() + ${minutes(input.minutes)} * 60000)${extra} }); cal.events.push(e); JSON.stringify({ summary: e.summary() })` };
}

export function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
      else resolve(stdout.trim());
    });
  });
}

export async function macAppCall(input: MacAppInput, run: (script: string) => Promise<string> = runOsascript): Promise<MacAppResult> {
  if (process.platform !== "darwin") return { ok: false, error: "mac_apps only works on macOS" };
  const built = macAppScript(input);
  if ("error" in built) return { ok: false, error: built.error };
  try {
    const out = await run(built.script);
    const items = out.startsWith("[") ? JSON.parse(out) : undefined;
    if (items) return { ok: true, items };
    try {
      const parsed = JSON.parse(out);
      const name = parsed?.name ?? parsed?.summary;
      return name !== undefined ? { ok: true, name } : { ok: true, item: parsed };
    } catch { return { ok: true, name: out.slice(0, TEXT_LIMIT) }; }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "the app did not answer" };
  }
}

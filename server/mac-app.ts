// Structured reads and writes into the Mac's own apps (Notes, Reminders, Calendar) through JXA —
// the same osascript surface `native:bash` could reach, but shaped so a bot needn't hand-write
// AppleScript. Writes are gated by the caller on the bot's approval mode, matching what a bash
// osascript would cost the person.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const MAC_APP_ACTIONS = [
  "notes_list", "notes_read", "notes_create",
  "reminders_list", "reminders_add", "reminders_done",
  "calendar_events", "calendar_add",
] as const;
export type MacAppAction = (typeof MAC_APP_ACTIONS)[number];

/** Actions that change the person's data; reads are the rest. */
export const MAC_APP_WRITES: ReadonlySet<MacAppAction> = new Set(["notes_create", "reminders_add", "reminders_done", "calendar_add"]);

const LIMIT = 50;
const lit = (value: unknown) => JSON.stringify(value ?? "");

// JXA prints the JSON result on stdout; osascript errors (missing app, TCC denial) surface on stderr.
const SCRIPTS: Record<MacAppAction, (input: Record<string, unknown>) => string> = {
  notes_list: () => `
    const app = Application("Notes");
    const out = [];
    for (const n of app.notes()) {
      let folder = null;
      try { folder = n.container().name(); } catch (e) {}
      out.push({ name: n.name(), folder });
      if (out.length >= ${LIMIT}) break;
    }
    console.log(JSON.stringify(out));`,
  notes_read: (input) => `
    const app = Application("Notes");
    const hits = app.notes.whose({ name: ${lit(input.name)} })();
    if (!hits.length) { console.log(JSON.stringify({ error: "no note with that name" })); }
    else {
      const n = hits[0];
      const body = String(n.body()).replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim();
      console.log(JSON.stringify({ name: n.name(), body: body.slice(0, 8000), truncated: body.length > 8000 }));
    }`,
  notes_create: (input) => `
    const app = Application("Notes");
    const name = ${lit(input.name)};
    const body = ${lit(input.body)};
    const account = app.defaultAccount();
    const folder = account.folders.byName("Notes");
    const note = app.Note({ name, body: "<h1>" + name + "</h1><div>" + body.replace(/\\n/g, "<br>") + "</div>" });
    folder.notes.push(note);
    console.log(JSON.stringify({ created: name }));`,
  reminders_list: () => `
    const app = Application("Reminders");
    const out = [];
    for (const list of app.lists()) {
      for (const r of list.reminders.whose({ completed: false })()) {
        let due = null;
        try { due = r.dueDate() ? r.dueDate().toISOString() : null; } catch (e) {}
        out.push({ name: r.name(), list: list.name(), due });
        if (out.length >= ${LIMIT}) break;
      }
      if (out.length >= ${LIMIT}) break;
    }
    console.log(JSON.stringify(out));`,
  reminders_add: (input) => `
    const app = Application("Reminders");
    const listName = ${lit(input.list)};
    const list = listName ? app.lists.byName(listName) : app.defaultList();
    const spec = { name: ${lit(input.name)} };
    if (${lit(input.due)}) spec.dueDate = new Date(${lit(input.due)});
    list.reminders.push(app.Reminder(spec));
    console.log(JSON.stringify({ added: spec.name, list: list.name() }));`,
  reminders_done: (input) => `
    const app = Application("Reminders");
    let done = 0;
    for (const list of app.lists()) {
      for (const r of list.reminders.whose({ completed: false, name: ${lit(input.name)} })()) {
        r.completed = true; done += 1;
      }
    }
    console.log(JSON.stringify(done ? { completed: done } : { error: "no open reminder with that name" }));`,
  calendar_events: (input) => `
    const app = Application("Calendar");
    const days = Math.min(30, Math.max(1, Number(${lit(input.days)}) || 7));
    const now = new Date();
    const till = new Date(now.getTime() + days * 86400000);
    const out = [];
    for (const cal of app.calendars()) {
      for (const e of cal.events()) {
        const start = e.startDate();
        if (start >= now && start <= till) {
          out.push({ title: e.summary(), calendar: cal.name(), start: start.toISOString(), end: e.endDate().toISOString() });
          if (out.length >= ${LIMIT}) break;
        }
      }
      if (out.length >= ${LIMIT}) break;
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    console.log(JSON.stringify(out));`,
  calendar_add: (input) => `
    const app = Application("Calendar");
    const calName = ${lit(input.calendar)};
    const cal = calName ? app.calendars.byName(calName) : app.calendars[0];
    const start = new Date(${lit(input.start)});
    const end = ${lit(input.end)} ? new Date(${lit(input.end)}) : new Date(start.getTime() + 3600000);
    cal.events.push(app.Event({ summary: ${lit(input.title)}, startDate: start, endDate: end }));
    console.log(JSON.stringify({ added: ${lit(input.title)}, calendar: cal.name() }));`,
};

export interface MacAppResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type MacAppExec = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

export async function runMacApp(action: MacAppAction, input: Record<string, unknown> = {}, execImpl: MacAppExec = exec): Promise<MacAppResult> {
  if (process.platform !== "darwin") return { ok: false, error: "mac_app needs macOS" };
  try {
    const { stdout, stderr } = await execImpl("osascript", ["-l", "JavaScript", "-e", SCRIPTS[action](input)], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.trim();
    if (!line) return { ok: false, error: stderr.trim() || "no result" };
    try {
      const parsed = JSON.parse(line) as { error?: string } | unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") return { ok: false, error: (parsed as { error: string }).error };
      return { ok: true, result: parsed };
    } catch {
      return { ok: true, result: line };
    }
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr?.trim() || err.message) ?? "osascript failed" };
  }
}

import { describe, expect, it } from "vitest";
import { macAppCall, macAppScript } from "./mac-apps.ts";

describe("macAppScript", () => {
  it("rejects unknown apps and actions outside each app's matrix", () => {
    expect(macAppScript({ app: "photos", action: "list" })).toHaveProperty("error");
    expect(macAppScript({ app: "reminders", action: "update" })).toHaveProperty("error");
    expect(macAppScript({ app: "notes", action: "complete", title: "x" })).toHaveProperty("error");
    expect(macAppScript({ app: "mail", action: "create", title: "x" })).toHaveProperty("error");
    expect(macAppScript({ app: "reminders", action: "delete" })).toHaveProperty("error");
  });

  it("builds reminder list and create scripts with escaped args", () => {
    expect(macAppScript({ app: "reminders", action: "list" })).toHaveProperty("script", expect.stringContaining("Reminders"));
    const created = macAppScript({ app: "reminders", action: "create", title: 'Buy "milk"', body: "from the shop" });
    expect(created).toHaveProperty("script", expect.stringContaining('name: "Buy \\"milk\\""'));
    expect(created).toHaveProperty("script", expect.stringContaining('body: "from the shop"'));
  });

  it("bounds calendar list by days and embeds the window", () => {
    expect(macAppScript({ app: "calendar", action: "list", days: 3 })).toHaveProperty("script", expect.stringContaining("3 * 86400000"));
    expect(macAppScript({ app: "calendar", action: "list" })).toHaveProperty("script", expect.stringContaining("7 * 86400000"));
    expect(macAppScript({ app: "calendar", action: "list", days: 999 })).toHaveProperty("script", expect.stringContaining("31 * 86400000"));
  });

  it("creates calendar events on a named calendar or the first one", () => {
    const named = macAppScript({ app: "calendar", action: "create", title: "Lunch", calendar: "Home" });
    expect(named).toHaveProperty("script", expect.stringContaining('c.name() === "Home"'));
    expect(macAppScript({ app: "calendar", action: "create", title: "Lunch" })).toHaveProperty("script", expect.stringContaining("calendars()[0]"));
  });

  it("embeds due, startsAt and minutes as epoch milliseconds, never strings", () => {
    const due = macAppScript({ app: "reminders", action: "create", title: "Tax", due: "2030-04-01T09:00:00Z" });
    expect(due).toHaveProperty("script", expect.stringContaining(`dueDate: new Date(${Date.parse("2030-04-01T09:00:00Z")})`));
    const at = macAppScript({ app: "calendar", action: "create", title: "Standup", startsAt: "2030-01-05T10:00:00Z", minutes: 30 });
    expect(at).toHaveProperty("script", expect.stringContaining(`var start = new Date(${Date.parse("2030-01-05T10:00:00Z")})`));
    expect(at).toHaveProperty("script", expect.stringContaining("30 * 60000"));
    expect(JSON.stringify(at)).not.toContain("2030-01-05");
    expect(macAppScript({ app: "reminders", action: "create", title: "x", due: "soon" })).toHaveProperty("error", expect.stringContaining("due"));
    expect(macAppScript({ app: "calendar", action: "create", title: "x", startsAt: "later" })).toHaveProperty("error", expect.stringContaining("startsAt"));
  });

  it("lists inbox mail with subject, sender and read state only", () => {
    const listed = macAppScript({ app: "mail", action: "list" });
    expect(listed).toHaveProperty("script", expect.stringContaining("Mail"));
    expect(JSON.stringify(listed)).toContain("subject");
    expect(JSON.stringify(listed)).not.toContain("content()");
  });

  it("completes and deletes reminders by first exact name match across lists", () => {
    const done = macAppScript({ app: "reminders", action: "complete", title: "Tax" });
    expect(done).toHaveProperty("script", expect.stringContaining("hit.completed = true"));
    expect(done).toHaveProperty("script", expect.stringContaining("!r.completed()"));
    const gone = macAppScript({ app: "reminders", action: "delete", title: "Tax" });
    expect(gone).toHaveProperty("script", expect.stringContaining("app.delete(hit)"));
    expect(JSON.stringify(gone)).not.toContain("!r.completed()");
  });

  it("deletes a calendar event by summary, optionally pinned to startsAt", () => {
    const any = macAppScript({ app: "calendar", action: "delete", title: "Lunch" });
    expect(any).toHaveProperty("script", expect.stringContaining("e.summary() === \"Lunch\""));
    expect(JSON.stringify(any)).not.toContain("startDate().getTime");
    const pinned = macAppScript({ app: "calendar", action: "delete", title: "Lunch", startsAt: "2030-01-05T10:00:00Z" });
    expect(pinned).toHaveProperty("script", expect.stringContaining(`e.startDate().getTime() - ${Date.parse("2030-01-05T10:00:00Z")}`));
    expect(macAppScript({ app: "calendar", action: "delete", title: "x", startsAt: "soon" })).toHaveProperty("error", expect.stringContaining("startsAt"));
  });

  it("reads one mail body by exact subject, bounded", () => {
    const read = macAppScript({ app: "mail", action: "read", title: "Invoice #7" });
    expect(read).toHaveProperty("script", expect.stringContaining('m.subject() === "Invoice #7"'));
    expect(read).toHaveProperty("script", expect.stringContaining("String(m.content()).slice(0, 4000)"));
  });
});

// The calls answer "mac_apps only works on macOS" before any script runs, so the script-and-answer tests need a Mac;
// they run on the macOS shard (host-tests) and are skipped where the app's own apps cannot exist.
describe.skipIf(process.platform !== "darwin")("macAppCall", () => {
  it("never spawns for bad input", async () => {
    let ran = false;
    const result = await macAppCall({ app: "photos", action: "list" }, async () => { ran = true; return ""; });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("reminders") });
    expect(ran).toBe(false);
  });

  it("parses a JSON list result", async () => {
    const result = await macAppCall({ app: "notes", action: "list" }, async () => '[{"name":"todo"},{"name":"idea"}]');
    expect(result).toEqual({ ok: true, items: [{ name: "todo" }, { name: "idea" }] });
  });

  it("reads a created name back", async () => {
    const result = await macAppCall({ app: "reminders", action: "create", title: "x" }, async () => '{"name":"x"}');
    expect(result).toEqual({ ok: true, name: "x" });
  });

  it("returns a mail read result as an item", async () => {
    const result = await macAppCall({ app: "mail", action: "read", title: "Hi" }, async () => '{"subject":"Hi","sender":"a@b.c","body":"text"}');
    expect(result).toEqual({ ok: true, item: { subject: "Hi", sender: "a@b.c", body: "text" } });
  });

  it("turns osascript failures into errors", async () => {
    const result = await macAppCall({ app: "notes", action: "list" }, async () => { throw new Error("not authorized"); });
    expect(result).toEqual({ ok: false, error: "not authorized" });
  });
});

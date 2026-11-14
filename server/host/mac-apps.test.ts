import { describe, expect, it } from "vitest";
import { macAppCall, macAppScript } from "./mac-apps.ts";

describe("macAppScript", () => {
  it("rejects unknown apps and actions", () => {
    expect(macAppScript({ app: "mail", action: "list" })).toHaveProperty("error");
    expect(macAppScript({ app: "reminders", action: "delete" })).toHaveProperty("error");
    expect(macAppScript({ app: "reminders", action: "create" })).toHaveProperty("error");
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
});

describe("macAppCall", () => {
  it("never spawns for bad input", async () => {
    let ran = false;
    const result = await macAppCall({ app: "mail", action: "list" }, async () => { ran = true; return ""; });
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

  it("turns osascript failures into errors", async () => {
    const result = await macAppCall({ app: "notes", action: "list" }, async () => { throw new Error("not authorized"); });
    expect(result).toEqual({ ok: false, error: "not authorized" });
  });
});

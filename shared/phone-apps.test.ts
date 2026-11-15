import { describe, expect, it } from "vitest";
import { isOutboundTool, isReadOnlyTool } from "./outbound.ts";
import { ALL_PHONE_APPS, DEFAULT_PHONE_CAPABILITIES, PHONE_CAPABILITIES, PHONE_TOOL_NAMES, isPhoneWrite, normalizePhoneApps, phoneToolCapability, phoneToolSends } from "./phone-apps.ts";

describe("phone tool vocabulary", () => {
  it("maps every tool to one capability", () => {
    for (const name of PHONE_TOOL_NAMES) expect(PHONE_CAPABILITIES).toContain(phoneToolCapability(name));
    expect(phoneToolCapability("PHONE_SEND_WHATSAPP")).toBe("messages");
    expect(phoneToolCapability("PHONE_FIND_PLACES_NEARBY")).toBe("location");
    for (const name of ["PHONE_UI_OBSERVE", "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL", "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK", "PHONE_UI_WAIT", "PHONE_UI_SCREENSHOT", "PHONE_UI_OCR", "PHONE_CLIPBOARD_GET", "PHONE_CLIPBOARD_SET", "PHONE_FILE_SHARE"]) {
      expect(phoneToolCapability(name)).toBe("phoneUi");
    }
    // Files and notifications stand apart from the screen: their reads need no helper.
    for (const name of ["PHONE_NOTIF_LIST", "PHONE_FILE_LIST", "PHONE_FILE_READ"]) {
      expect(phoneToolCapability(name)).toBe("phoneData");
    }
  });
  it("splits reads from writes by verb; observing, waiting, screenshots, OCR and clipboard reads are reads", () => {
    expect(PHONE_TOOL_NAMES.filter((n) => !isPhoneWrite(n))).toEqual(["PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_LIST_REMINDERS", "PHONE_SEARCH_CONTACTS", "PHONE_GET_CONTACT", "PHONE_GET_LOCATION", "PHONE_FIND_PLACES_NEARBY", "PHONE_LIST_HOME", "PHONE_UI_OBSERVE", "PHONE_UI_WAIT", "PHONE_UI_SCREENSHOT", "PHONE_UI_OCR", "PHONE_CLIPBOARD_GET", "PHONE_NOTIF_LIST", "PHONE_FILE_LIST", "PHONE_FILE_READ"]);
  });
  it("is classed by the existing outbound rules with no special case", () => {
    expect(isOutboundTool("PHONE_SEND_MESSAGE")).toBe(true);
    expect(isOutboundTool("mcp__device__PHONE_SEND_WHATSAPP")).toBe(true);
    expect(isOutboundTool("PHONE_CREATE_EVENT")).toBe(false);
    expect(isReadOnlyTool("PHONE_LIST_EVENTS")).toBe(true);
    expect(phoneToolSends("PHONE_SEND_MESSAGE")).toBe(true);
    expect(phoneToolSends("PHONE_CREATE_REMINDER")).toBe(false);
  });
  it("observing the screen is read-only, every other UI control is outbound under either spelling", () => {
    for (const name of ["PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL", "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK", "PHONE_CLIPBOARD_SET", "PHONE_FILE_SHARE"]) {
      expect(isOutboundTool(name), name).toBe(true);
      expect(isOutboundTool(`mcp__device__${name}`), name).toBe(true);
      expect(isPhoneWrite(name), name).toBe(true);
    }
    expect(isOutboundTool("PHONE_UI_OBSERVE")).toBe(false);
    expect(isOutboundTool("mcp__device__PHONE_UI_OBSERVE")).toBe(false);
    expect(isReadOnlyTool("PHONE_UI_OBSERVE")).toBe(true);
    expect(isReadOnlyTool("mcp__device__PHONE_UI_OBSERVE")).toBe(true);
    expect(isOutboundTool("PHONE_UI_WAIT")).toBe(false);
    expect(isReadOnlyTool("PHONE_UI_WAIT")).toBe(true);
    expect(isPhoneWrite("PHONE_UI_WAIT")).toBe(false);
    expect(isOutboundTool("PHONE_UI_SCREENSHOT")).toBe(false);
    expect(isReadOnlyTool("PHONE_UI_SCREENSHOT")).toBe(true);
    expect(isOutboundTool("PHONE_UI_OCR")).toBe(false);
    expect(isReadOnlyTool("PHONE_UI_OCR")).toBe(true);
    expect(isOutboundTool("PHONE_CLIPBOARD_GET")).toBe(false);
    expect(isReadOnlyTool("PHONE_CLIPBOARD_GET")).toBe(true);
    expect(isPhoneWrite("PHONE_CLIPBOARD_GET")).toBe(false);
    expect(phoneToolSends("PHONE_UI_TAP")).toBe(false);
  });
  it("normalizes grants", () => {
    expect(normalizePhoneApps({ calendar: "read", messages: "write" })).toEqual({ calendar: "read", messages: "write" });
    expect(normalizePhoneApps({})).toEqual({});
    expect(normalizePhoneApps({ calendar: "full" })).toBeNull();
    expect(normalizePhoneApps({ health: "read" })).toBeNull();
    expect(normalizePhoneApps({ phoneUi: "write" })).toEqual({ phoneUi: "write" });
    expect(normalizePhoneApps("read")).toBeNull();
  });
  it("the default grant keeps the six legacy apps and never the screen", () => {
    expect(Object.keys(ALL_PHONE_APPS)).toEqual([...DEFAULT_PHONE_CAPABILITIES]);
    expect(Object.keys(ALL_PHONE_APPS)).toEqual(["calendar", "reminders", "contacts", "location", "home", "messages"]);
    expect(ALL_PHONE_APPS.phoneUi).toBeUndefined();
    expect(PHONE_CAPABILITIES).toContain("phoneUi");
  });
});

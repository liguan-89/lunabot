import { describe, expect, it } from "vitest";

import { PHONE_TOOL_NAMES } from "../../shared/phone-apps.ts";
import { PHONE_TOOLS, phoneOkResult, phoneToolCallProblem } from "./tools.ts";

describe("phone tools", () => {
  it("lists one schema per tool name and validates arguments", () => {
    expect(PHONE_TOOLS.map((t) => t.name)).toEqual([...PHONE_TOOL_NAMES]);
    expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch", start: "2026-10-24T12:00:00+05:30", end: "2026-10-24T13:00:00+05:30" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch" })).toMatch(/start/);
    expect(phoneToolCallProblem("PHONE_SEND_MESSAGE", { to: "Rahul", text: "x", extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_NOPE", {})).toMatch(/Unknown phone tool/);
  });

  it("the screen tools take a ref, an app, or nothing, and never a screenshot", () => {
    expect(phoneToolCallProblem("PHONE_UI_OBSERVE", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_OBSERVE", { extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_UI_QUERY", { text: "Settings" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_QUERY", { resourceId: "com.android.settings:id/search", role: "android.widget.Button", limit: 10 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_QUERY", {})).toMatch(/text.*resourceId.*role/);
    expect(phoneToolCallProblem("PHONE_UI_QUERY", { limit: 0 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_UI_QUERY", { limit: 101 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_UI_QUERY", { text: "Settings", extra: 1 })).toMatch(/extra/);
    // Find takes the query's selectors plus where and how far to scroll; it needs the same one target selector.
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "down" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_FIND", { resourceId: "com.android.settings:id/search", direction: "up" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_FIND", { role: "android.widget.Button", direction: "down", maxScrolls: 5, limit: 10 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_FIND", { direction: "down" })).toMatch(/text.*resourceId.*role/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings" })).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "sideways" })).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "down", maxScrolls: 0 })).toMatch(/maxScrolls/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "down", maxScrolls: 201 })).toMatch(/maxScrolls/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "down", limit: 0 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_UI_FIND", { text: "Settings", direction: "down", extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_LIST_APPS", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_LIST_APPS", { query: "settings", limit: 20 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_LIST_APPS", { limit: 0 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_LIST_APPS", { limit: 201 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_LIST_APPS", { extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_UI_LAUNCH", { app: "com.example.app" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_LAUNCH", {})).toMatch(/app/);
    expect(phoneToolCallProblem("PHONE_UI_TAP", { ref: "e12" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_TAP", {})).toMatch(/ref/);
    expect(phoneToolCallProblem("PHONE_UI_TYPE", { text: "hello" })).toMatch(/ref/);
    expect(phoneToolCallProblem("PHONE_UI_TYPE", { text: "hello", ref: "e3" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_TYPE", { ref: "e3" })).toMatch(/text/);
    expect(phoneToolCallProblem("PHONE_UI_SCROLL", { direction: "down" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_SCROLL", { direction: "sideways" })).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_SWIPE", { direction: "left" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_SWIPE", { direction: "diagonal" })).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_SWIPE", {})).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_KEY", { key: "enter" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_KEY", { key: "home" })).toMatch(/key/);
    expect(phoneToolCallProblem("PHONE_UI_WAIT", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_WAIT", { mode: "change", timeoutMs: 1_000 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_WAIT", { mode: "forever" })).toMatch(/mode/);
    expect(phoneToolCallProblem("PHONE_UI_WAIT", { timeoutMs: 99_999 })).toMatch(/timeoutMs/);
    expect(phoneToolCallProblem("PHONE_UI_TAP_AT", { x: 10, y: 20 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_TAP_AT", { x: 10 })).toMatch(/y/);
    expect(phoneToolCallProblem("PHONE_UI_TAP_AT", { x: -1, y: 0 })).toMatch(/x/);
    expect(phoneToolCallProblem("PHONE_UI_SCREENSHOT", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_OCR", { maxLines: 50 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_OCR", { maxLines: 0 })).toMatch(/maxLines/);
    expect(phoneToolCallProblem("PHONE_CLIPBOARD_GET", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_CLIPBOARD_SET", { text: "hello" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_CLIPBOARD_SET", {})).toMatch(/text/);
    expect(phoneToolCallProblem("PHONE_NOTIF_LIST", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_NOTIF_LIST", { limit: 5, sinceMinutes: 30 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_NOTIF_LIST", { limit: 99 })).toMatch(/limit/);
    expect(phoneToolCallProblem("PHONE_FILE_LIST", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_LIST", { kind: "document", query: "合同", limit: 3 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_LIST", { kind: "audio" })).toMatch(/kind/);
    expect(phoneToolCallProblem("PHONE_FILE_READ", { fileId: "photo:12" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_READ", {})).toMatch(/fileId/);
    expect(phoneToolCallProblem("PHONE_FILE_READ", { fileId: "photo:12", pages: 9 })).toMatch(/pages/);
    expect(phoneToolCallProblem("PHONE_FILE_SEND", { fileId: "photo:12" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_SEND", {})).toMatch(/fileId/);
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", { fileId: "photo:12" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", { fileId: "photo:12", package: "com.tencent.mm" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", {})).toMatch(/fileId/);
    expect(phoneToolCallProblem("PHONE_UI_BACK", {})).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [{ op: "tap", text: "发送" }] })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [{ op: "launch", app: "com.miui.calculator" }, { op: "type", ref: "e3", text: "12", pressEnter: true }] })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [] })).toMatch(/commands/);
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: Array.from({ length: 21 }, () => ({ op: "observe" })) })).toMatch(/commands/);
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [{ op: "pinch" }] })).toMatch(/op/);
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [{ op: "observe", extra: 1 }] })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_UI_RUN", { commands: [{ op: "tap", text: "发送", pressEnter: true }] })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_RUN", {})).toMatch(/commands/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", pages: 3, maxLines: 120, fromY: 100, toY: 900 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "sideways" })).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", {})).toMatch(/direction/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", pages: 0 })).toMatch(/pages/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", pages: 21 })).toMatch(/pages/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", maxLines: 0 })).toMatch(/maxLines/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", maxLines: 1001 })).toMatch(/maxLines/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", fromY: -1 })).toMatch(/fromY/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", toY: 1000 })).toMatch(/toY/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", fromY: 900, toY: 100 })).toMatch(/fromY/);
    expect(phoneToolCallProblem("PHONE_UI_COLLECT", { direction: "down", extra: 1 })).toMatch(/extra/);
    const observe = PHONE_TOOLS.find((t) => t.name === "PHONE_UI_OBSERVE")!;
    expect(JSON.stringify(observe.inputSchema)).not.toMatch(/screenshot/i);
  });

  it("the intent tools take a clock time, a length, a link or text, and refuse what they cannot do", () => {
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 30 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 30, label: "Gym", days: ["MON", "WED", "FRI"], vibrate: true })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { minute: 30 })).toMatch(/hour/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 24, minute: 30 })).toMatch(/hour/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 60 })).toMatch(/minute/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: -1 })).toMatch(/minute/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 30, days: ["MONDAY"] })).toMatch(/days/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 30, days: ["MON", "MON", "MON", "MON", "MON", "MON", "MON", "MON"] })).toMatch(/days/);
    expect(phoneToolCallProblem("PHONE_SET_ALARM", { hour: 7, minute: 30, extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_SET_TIMER", { seconds: 90 })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SET_TIMER", { seconds: 90, label: "Tea" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SET_TIMER", {})).toMatch(/seconds/);
    expect(phoneToolCallProblem("PHONE_SET_TIMER", { seconds: 0 })).toMatch(/seconds/);
    expect(phoneToolCallProblem("PHONE_SET_TIMER", { seconds: 86_401 })).toMatch(/seconds/);
    expect(phoneToolCallProblem("PHONE_OPEN_LINK", { url: "https://example.com/a?b=c" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_OPEN_LINK", { url: "http://example.com", app: "com.tencent.mm" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_OPEN_LINK", {})).toMatch(/url/);
    expect(phoneToolCallProblem("PHONE_OPEN_LINK", { url: `https://example.com/${"a".repeat(2_000)}` })).toMatch(/url/);
    expect(phoneToolCallProblem("PHONE_OPEN_LINK", { url: "https://example.com", extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_SHARE_TEXT", { text: "见字如面" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SHARE_TEXT", { text: "见字如面", app: "com.tencent.mm" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_SHARE_TEXT", {})).toMatch(/text/);
    expect(phoneToolCallProblem("PHONE_SHARE_TEXT", { text: "" })).toMatch(/text/);
    expect(phoneToolCallProblem("PHONE_SHARE_TEXT", { text: "a".repeat(5_001) })).toMatch(/text/);
  });

  it("the after-task choice is keep or close, for the app the task drove or one it names", () => {
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", { action: "keep" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", { action: "close", app: "com.tencent.mm" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", {})).toMatch(/action/);
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", { action: "background" })).toMatch(/action/);
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", { action: "keep", extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_UI_AFTER_TASK", { action: "keep", app: "a".repeat(201) })).toMatch(/app/);
  });

  it("a screenshot becomes an image block, not a base64 pile in the text", () => {
    const ok = phoneOkResult(
      { image: "QUJD", mimeType: "image/jpeg", width: 720, height: 1280 },
      { name: "Omkar's iPhone", platform: "android" },
    );
    expect(ok.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
    expect(ok.structuredContent).toEqual({
      mimeType: "image/jpeg", width: 720, height: 1280,
      phone: { name: "Omkar's iPhone", platform: "android" }, imageBytes: 4,
    });
    expect(JSON.stringify(ok.structuredContent)).not.toContain("QUJD");
  });

  it("an answer's own phone key never relabels the phone it ran on", () => {
    const phone = { name: "Omkar's iPhone", platform: "ios" } as const;
    const ok = phoneOkResult({ phone: { name: "Someone else's phone", platform: "android" }, events: [] }, phone);
    expect(ok.structuredContent).toEqual({ events: [], phone });
    expect(JSON.parse(ok.content[0]!.type === "text" ? ok.content[0]!.text : "{}")).toEqual({ events: [], phone });
  });
});

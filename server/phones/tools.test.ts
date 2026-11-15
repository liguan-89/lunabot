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
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", { fileId: "photo:12" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", { fileId: "photo:12", package: "com.tencent.mm" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_FILE_SHARE", {})).toMatch(/fileId/);
    expect(phoneToolCallProblem("PHONE_UI_BACK", {})).toBeNull();
    const observe = PHONE_TOOLS.find((t) => t.name === "PHONE_UI_OBSERVE")!;
    expect(JSON.stringify(observe.inputSchema)).not.toMatch(/screenshot/i);
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
    expect(JSON.parse(ok.content[0]!.text)).toEqual({ events: [], phone });
  });
});

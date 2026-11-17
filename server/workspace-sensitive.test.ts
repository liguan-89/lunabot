// Adapted from Mika's SensitiveFilter (Apache-2.0): the gate over memory writes.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { appendMemoryLog, readMemoryFile, readMemoryLog, updateMemory, WORKSPACES_DIR } from "./workspace.ts";

const BOT = "bot-workspace-sensitive";
const NOW = new Date(2026, 8, 10, 12);

describe("the sensitive gate over memory writes", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("refuses a note holding a one-time code and writes nothing", () => {
    const refused = updateMemory(BOT, { action: "append", text: "验证码 4821 是刚才那条短信里的" }, { now: NOW });
    expect(refused).toMatchObject({ ok: false, code: "invalid" });
    // The reason names the kind, never the code.
    const error = refused.ok ? "" : refused.error;
    expect(error).toContain("a password or one-time code");
    expect(error).not.toContain("4821");
    expect(readMemoryFile(BOT).text).toBe("");
  });

  it("refuses a note holding a password, a card number or an ID number", () => {
    for (const [text, kind] of [
      ["支付密码是123456", "a password or one-time code"],
      ["卡号 4111 1111 1111 1111", "a card number"],
      ["身份证 11010519491231002X", "an ID number"],
    ] as const) {
      const result = updateMemory(BOT, { action: "append", text }, { now: NOW });
      expect(result).toMatchObject({ ok: false, code: "invalid" });
      expect(result.ok ? "" : result.error).toContain(kind);
    }
    expect(readMemoryFile(BOT).text).toBe("");
  });

  it("still writes an ordinary note, phone number and birthday included", () => {
    expect(updateMemory(BOT, { action: "append", text: "手机号 13800138000，生日 1960-05-01" }, { now: NOW }))
      .toMatchObject({ ok: true, entry: "- 2026-09-10 · 手机号 13800138000，生日 1960-05-01" });
    expect(readMemoryFile(BOT).text).toContain("13800138000");
  });

  it("refuses a log line holding a code, and keeps the day's file untouched", () => {
    expect(appendMemoryLog(BOT, "验证码 552211 收到", { now: NOW })).toMatchObject({ ok: false, code: "invalid" });
    expect(readMemoryLog(BOT, "2026-09-10.md")).toBeNull();
    expect(appendMemoryLog(BOT, "shipped 0.1.70", { now: NOW }).ok).toBe(true);
    expect(readMemoryLog(BOT, "2026-09-10.md")).toContain("shipped 0.1.70");
  });
});

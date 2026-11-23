import { describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { serverLine } from "./server-lines.ts";

describe("serverLine", () => {
  it("writes the line in the language given, with its values filled in", () => {
    expect(serverLine("zh", "server.reports.sent", { report: "r-1" })).toBe("已发送给 Luna Bot 团队（报告 r-1）。Milind 和 Omkar 会通过邮件收到。");
    expect(serverLine(undefined, "server.reports.sent", { report: "r-1" })).toBe("Sent to the Luna Bot team (report r-1). Milind and Omkar get it by email.");
    expect(serverLine("en", "server.reports.when.minutes", { count: 5 })).toBe("in about 5 minutes");
  });

  it("reads a regional tag as its language, and a language it has no words for as English", () => {
    expect(serverLine("zh-CN", "server.reports.when.soon")).toBe("尽快");
    expect(serverLine("zh-Hant", "server.reports.when.soon")).toBe(serverLine("zh", "server.reports.when.soon"));
    expect(serverLine("nl", "server.reports.when.soon")).toBe("as soon as it can");
  });

  it("leaves a {name} it was given no value for as it is", () => {
    expect(serverLine("en", "server.reports.refused", {})).toBe("The Luna Bot team's server refused this bug report, so nothing was sent: {detail}.");
  });
});

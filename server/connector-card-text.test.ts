import { describe, expect, it } from "vitest";

import { connectorCardDescription, connectorCardText, signInCardText } from "./connector-card-text.ts";
import "./server-line-packs.ts";

describe("connectorCardText", () => {
  it("names the app the bot is waiting on", () => {
    expect(connectorCardText("GitHub")).toBe("Connect GitHub to continue.");
  });

  it("names the account for a second-account card", () => {
    expect(connectorCardText("Gmail", "work")).toBe("Connect Gmail as “work” to continue.");
  });

  it("collapses stray whitespace and never prints an empty name", () => {
    expect(connectorCardText("  Google \n Calendar ", "  ")).toBe("Connect Google Calendar to continue.");
    expect(connectorCardText("   ")).toBe("Connect this app to continue.");
  });

  it("says it in the language of the person the card is for", () => {
    expect(connectorCardText("Microsoft Clarity", undefined, "zh")).toBe("连接 Microsoft Clarity 以继续。");
    expect(connectorCardText("Gmail", "Arbeit", "zh")).toBe("以「Arbeit」身份连接 Gmail 以继续。");
    expect(connectorCardText("   ", undefined, "zh")).toBe("连接 此应用 以继续。");
    expect(connectorCardDescription("Notion", undefined, "zh")).toBe("连接 Notion，让机器人可以继续");
    expect(connectorCardDescription("Notion", undefined, undefined)).toBe("Connect Notion so the bot can continue");
    expect(signInCardText("Biber", "github.com", "zh"))
      .toBe("Biber 需要你登录 github.com。请在 Luna Bot 中打开此对话进行登录，然后在卡片上确认。");
    expect(signInCardText("Biber", "github.com")).toBe("Biber needs you to sign in to github.com. Open this conversation in Luna Bot to sign in, then press Done.");
  });
});

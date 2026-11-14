import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MarketSubscriptionCard } from "./MarketSubscriptionCard";

const bridge = {
  state: vi.fn().mockResolvedValue({ status: "signed-out" }),
  plans: vi.fn().mockResolvedValue({ contractVersion: 1, plans: [] }),
  subscriptions: vi.fn().mockResolvedValue({ contractVersion: 1, subscriptions: [] }),
  signIn: vi.fn(), signOut: vi.fn(), checkout: vi.fn(), checkoutStatus: vi.fn(), install: vi.fn(), installed: vi.fn(), manage: vi.fn(),
  onState: vi.fn(() => () => {}),
};

beforeEach(() => setLocale("en"));
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("MarketSubscriptionCard", () => {
  it("renders nothing when this build has no TK1688 bridge", () => {
    vi.stubGlobal("window", {});
    expect(renderToStaticMarkup(createElement(MarketSubscriptionCard))).toBe("");
  });

  it("offers a TK1688 sign-in before the person is signed in", () => {
    vi.stubGlobal("window", { ogb: { market: bridge } });
    const html = renderToStaticMarkup(createElement(MarketSubscriptionCard));
    expect(html).toContain("TK1688 API subscription");
    expect(html).toContain("Sign in to TK1688");
    expect(html).toContain("never sees your password");
  });
});
import { describe, expect, it } from "vitest";
import type { MarketPlan, MarketSubscription } from "../../electron/market-client.mjs";
import { formatUsd, marketTiers, monthlyEquivalent, paymentMethodFor, planFor, remainingPercent, sortSubscriptions, usableSubscription } from "./market-plans";

function plan(tier: string, period: MarketPlan["billing_period"], sort: number): MarketPlan {
  const months = period === "month" ? 1 : period === "quarter" ? 3 : 12;
  const base = Number(tier.slice(1));
  const price = period === "month" ? base : period === "quarter" ? base * 3 * 0.9 : base * 12 * 0.8;
  return {
    plan_code: `${tier}-${period[0]}`, tier_code: tier, title: `TK1688 API · ${base}`,
    billing_period: period, months, price_usd: price, list_price_usd: base * months,
    discount_percent: period === "month" ? 0 : period === "quarter" ? 10 : 20, currency: "USD",
    token_quota: base * 500_000 * months, quota_usd: base * months, days: period === "month" ? 30 : period === "quarter" ? 90 : 365,
    models: ["claude-sonnet-4-5"], payment_methods: ["epay", "balance"], sort_order: sort,
  };
}

function subscription(id: string, status: MarketSubscription["status"], expires: number, quota = 100, used = 25): MarketSubscription {
  return {
    subscription_id: id, plan_code: "t20-q", plan_title: "TK1688 API · 20 · 季付", status,
    started_at: 1, expires_at: expires, quota_total: quota, quota_used: used, quota_remaining: quota - used,
    models: [], token: { id: 1, masked: "sk-****0000", created_at: 1 },
  };
}

describe("market plan cards", () => {
  it("groups the twelve enabled SKUs into four tier cards with a period switch", () => {
    const plans = ["t5", "t20", "t50", "t100"].flatMap((tier, index) =>
      (["month", "quarter", "year"] as const).map((period) => plan(tier, period, index * 10)));
    const tiers = marketTiers(plans);
    expect(tiers.map((tier) => tier.tier_code)).toEqual(["t5", "t20", "t50", "t100"]);
    expect(planFor(tiers[1]!, "quarter")?.price_usd).toBe(54);
    expect(planFor(tiers[3]!, "year")?.price_usd).toBe(960);
    expect(tiers[0]!.plans.month?.list_price_usd).toBe(5);
    expect(tiers[2]!.plans.year?.discount_percent).toBe(20);
  });

  it("shows the monthly equivalent of a discounted period", () => {
    expect(monthlyEquivalent(plan("t20", "quarter", 0))).toBe(18);
    expect(monthlyEquivalent(plan("t20", "year", 0))).toBe(16);
    expect(formatUsd(13.5)).toBe("$13.50");
    expect(formatUsd(48)).toBe("$48");
  });

  it("prefers online checkout and falls back to wallet balance", () => {
    const both = plan("t20", "month", 0);
    expect(paymentMethodFor(both)).toBe("epay");
    expect(paymentMethodFor({ ...both, payment_methods: ["balance"] })).toBe("balance");
    expect(paymentMethodFor({ ...both, payment_methods: [] })).toBeUndefined();
  });

  it("keeps quota percentages inside 0 to 100", () => {
    expect(remainingPercent(subscription("sub_a", "active", 2, 100, 25))).toBe(75);
    expect(remainingPercent(subscription("sub_b", "active", 2, 100, 200))).toBe(0);
    expect(remainingPercent(subscription("sub_c", "expired", 2, 0, 0))).toBe(0);
  });

  it("sorts live subscriptions before expired ones", () => {
    const now = Date.now();
    const live = subscription("sub_live", "active", Math.floor(now / 1000) + 3600);
    const expired = subscription("sub_expired", "expired", Math.floor(now / 1000) - 3600);
    expect(usableSubscription(live, now)).toBe(true);
    expect(usableSubscription(expired, now)).toBe(false);
    expect(sortSubscriptions([expired, live], now).map((item) => item.subscription_id)).toEqual(["sub_live", "sub_expired"]);
  });
});
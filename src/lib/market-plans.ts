import type { MarketBillingPeriod, MarketPaymentMethod, MarketPlan, MarketSubscription } from "../../electron/market-client.mjs";

export const MARKET_PERIODS: readonly MarketBillingPeriod[] = ["month", "quarter", "year"];

export interface MarketTier {
  tier_code: string;
  title: string;
  sort: number;
  plans: Record<MarketBillingPeriod, MarketPlan | undefined>;
}

/** One card per tier: the three periods are a switch on that card, never three cards. */
export function marketTiers(plans: readonly MarketPlan[]): MarketTier[] {
  const tiers = new Map<string, MarketTier>();
  for (const plan of plans) {
    const existing = tiers.get(plan.tier_code);
    const tier = existing ?? { tier_code: plan.tier_code, title: plan.title, sort: plan.sort_order, plans: { month: undefined, quarter: undefined, year: undefined } };
    tier.plans[plan.billing_period] = plan;
    tier.sort = Math.min(tier.sort, plan.sort_order);
    tiers.set(plan.tier_code, tier);
  }
  return [...tiers.values()].sort((left, right) => left.sort - right.sort || left.tier_code.localeCompare(right.tier_code));
}

export function planFor(tier: MarketTier, period: MarketBillingPeriod): MarketPlan | undefined {
  return tier.plans[period];
}

export function monthlyEquivalent(plan: MarketPlan): number {
  return plan.months > 0 ? plan.price_usd / plan.months : plan.price_usd;
}

/** Prefer the hosted checkout (epay) when the plan offers it; otherwise fall back to wallet balance. */
export function paymentMethodFor(plan: MarketPlan, preferred: MarketPaymentMethod = "epay"): MarketPaymentMethod | undefined {
  return plan.payment_methods.includes(preferred) ? preferred : plan.payment_methods[0];
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return value % 1 === 0 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

export function remainingPercent(subscription: MarketSubscription): number {
  if (subscription.quota_total <= 0) return subscription.status === "expired" || subscription.status === "canceled" ? 0 : 100;
  return Math.max(0, Math.min(100, (subscription.quota_remaining / subscription.quota_total) * 100));
}

export function usableSubscription(subscription: MarketSubscription, now = Date.now()): boolean {
  return (subscription.status === "active" || subscription.status === "expiring") && subscription.expires_at * 1000 > now;
}

/** Live subscriptions first, then the longest running; expired ones last so a renewal stays one click away. */
export function sortSubscriptions(subscriptions: readonly MarketSubscription[], now = Date.now()): MarketSubscription[] {
  const rank = (subscription: MarketSubscription) => usableSubscription(subscription, now) ? 0 : 1;
  return [...subscriptions].sort((left, right) => rank(left) - rank(right) || right.expires_at - left.expires_at);
}
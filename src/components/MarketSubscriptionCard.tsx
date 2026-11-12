import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import type { MarketBillingPeriod, MarketCheckout, MarketPlan, MarketSessionState, MarketSubscription } from "../../electron/market-client.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatUsd, MARKET_PERIODS, marketTiers, monthlyEquivalent, planFor, remainingPercent, sortSubscriptions, usableSubscription } from "@/lib/market-plans";
import { Card } from "./SettingsPrimitives";

const STATUS_KEY = {
  active: "market.status.active",
  expiring: "market.status.expiring",
  expired: "market.status.expired",
  canceled: "market.status.canceled",
} as const;

const PERIOD_KEY = {
  month: "market.period.month",
  quarter: "market.period.quarter",
  year: "market.period.year",
} as const;

const PAYMENT_POLL_MS = 2_000;
const CHECKOUT_LIMIT_MS = 15 * 60_000;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value * 1000));

export function MarketSubscriptionCard() {
  const bridge = window.ogb?.market;
  const [session, setSession] = useState<MarketSessionState | null>(null);
  const [plans, setPlans] = useState<MarketPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<MarketSubscription[]>([]);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [period, setPeriod] = useState<MarketBillingPeriod>("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<MarketCheckout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (polling.current) clearInterval(polling.current);
    polling.current = null;
  }, []);

  const refreshSubscriptions = useCallback(async () => {
    if (!bridge || session?.status !== "signed-in") return;
    try {
      const next = await bridge.subscriptions();
      setSubscriptions(next.subscriptions);
    } catch (failure) {
      setError(t("market.error", { message: errorText(failure) }));
    }
  }, [bridge, session?.status]);

  const watchCheckout = useCallback((opened: MarketCheckout) => {
    stopPolling();
    const started = Date.now();
    polling.current = setInterval(() => {
      void bridge?.checkoutStatus(opened.checkout_id).then((status) => {
        if (status.status === "active") {
          stopPolling();
          setCheckout(null);
          setBusy(null);
          void refreshSubscriptions();
          return;
        }
        if (status.status === "failed" || status.status === "expired" || status.status === "canceled") {
          stopPolling();
          setCheckout(null);
          setBusy(null);
          setError(t("market.checkoutFailed"));
          return;
        }
        if (Date.now() - started > CHECKOUT_LIMIT_MS) {
          stopPolling();
          setCheckout(null);
          setBusy(null);
          setError(t("market.checkoutTimeout"));
        }
      }, () => {});
    }, PAYMENT_POLL_MS);
  }, [bridge, refreshSubscriptions, stopPolling]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then((next) => { if (live) setSession(next); }, (failure) => { if (live) setError(errorText(failure)); });
    void bridge.plans().then((next) => { if (live) setPlans(next.plans); }, () => { if (live) setError(t("market.loadFailed")); });
    void bridge.installed().then((record) => {
      if (live && record) setInstalled({ [record.subscriptionId]: record.instanceId });
    }, () => {});
    const off = bridge.onState((next) => setSession(next));
    return () => { live = false; off(); stopPolling(); };
  }, [bridge, stopPolling]);

  useEffect(() => {
    if (session?.status !== "signed-in") {
      setSubscriptions([]);
      return;
    }
    void refreshSubscriptions();
  }, [session?.status, refreshSubscriptions]);

  const signIn = async () => {
    if (!bridge) return;
    setBusy("sign-in");
    setError(null);
    try { await bridge.signIn(); } catch { setError(t("market.signInFailed")); } finally { setBusy(null); }
  };

  const signOut = async () => {
    if (!bridge) return;
    setBusy("sign-out");
    setError(null);
    try { await bridge.signOut(); } finally { setBusy(null); }
  };

  const subscribe = async (plan: MarketPlan) => {
    if (!bridge) return;
    setBusy(plan.plan_code);
    setError(null);
    try {
      const opened = await bridge.checkout(plan.plan_code, "epay");
      setCheckout(opened);
      watchCheckout(opened);
    } catch (failure) {
      setBusy(null);
      setError(t("market.error", { message: errorText(failure) }));
    }
  };

  const cancelCheckout = () => {
    stopPolling();
    setCheckout(null);
    setBusy(null);
  };

  const install = async (subscription: MarketSubscription) => {
    if (!bridge) return;
    setBusy(subscription.subscription_id);
    setError(null);
    try {
      const result = await bridge.install(subscription.subscription_id);
      setInstalled((current) => ({ ...current, [subscription.subscription_id]: result.instanceId }));
    } catch (failure) {
      setError(t("market.error", { message: errorText(failure) }));
    } finally {
      setBusy(null);
    }
  };

  if (!bridge) return null;
  const tiers = marketTiers(plans);
  const ordered = sortSubscriptions(subscriptions);
  const waiting = busy === "sign-in" || busy === "sign-out";

  return (
    <Card title={t("market.title")} subtitle={t("market.subtitle")}>
      {error && <div role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-4 text-danger">{error}</div>}

      {session?.status !== "signed-in" ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-relaxed text-ink-secondary">{t("market.signInHint")}</p>
          <button type="button" className="ui-button ui-button-primary w-fit" disabled={waiting} onClick={() => void signIn()}>
            {busy === "sign-in" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <ExternalLink size={13} aria-hidden="true" />}
            {t("market.signIn")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-ink">
              {t("market.signedInAs", { name: session.user?.display_name ?? session.user?.username ?? "TK1688" })}
            </div>
            <div className="flex gap-2">
              <button type="button" className="ui-button" onClick={() => void bridge.manage()}>{t("market.manage")}</button>
              <button type="button" className="ui-button" disabled={waiting} onClick={() => void signOut()}>{t("market.signOut")}</button>
            </div>
          </div>

          {checkout && (
            <div className="rounded-lg bg-ink/5 px-3 py-2 text-[13px] leading-relaxed text-ink-secondary">
              <div className="flex items-center gap-2 font-medium text-ink"><CreditCard size={13} aria-hidden="true" />{t("market.waiting")}</div>
              <div>{t("market.checkoutOpened")}</div>
              <button type="button" className="ui-button mt-2" onClick={cancelCheckout}>{t("market.cancel")}</button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium text-ink">{t("market.plans")}</div>
            <div className="flex w-fit gap-1 rounded-full bg-ink/5 p-1">
              {MARKET_PERIODS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={period === option}
                  className={cn("rounded-full px-3 py-1 text-[12px]", period === option ? "bg-ink text-app" : "text-ink-secondary hover:text-ink")}
                  onClick={() => setPeriod(option)}
                >
                  {t(PERIOD_KEY[option])}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {tiers.map((tier) => {
                const plan = planFor(tier, period);
                if (!plan) return null;
                return (
                  <div key={tier.tier_code} className="flex flex-col rounded-xl border-[0.5px] border-(--settings-edge) p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[14px] font-medium text-ink">{t("market.planTitle", { price: formatUsd(plan.list_price_usd / plan.months) })}</div>
                      {plan.discount_percent > 0 && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent">{t("market.save", { percent: String(plan.discount_percent) })}</span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[20px] font-semibold text-ink">{formatUsd(plan.price_usd)}</span>
                      {plan.discount_percent > 0 && <span className="text-[12px] text-ink-secondary line-through">{formatUsd(plan.list_price_usd)}</span>}
                      <span className="text-[12px] text-ink-secondary">{t("market.monthly", { amount: formatUsd(monthlyEquivalent(plan)) })}</span>
                    </div>
                    <div className="mt-1 text-[12px] text-ink-secondary">{t("market.usage", { amount: formatUsd(plan.quota_usd) })}</div>
                    <button
                      type="button"
                      className="ui-button ui-button-primary mt-3 w-full"
                      disabled={busy !== null || checkout !== null}
                      onClick={() => void subscribe(plan)}
                    >
                      {busy === plan.plan_code && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                      {busy === plan.plan_code ? t("market.waiting") : t("market.subscribe")}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium text-ink">{t("market.manage")}</div>
            {ordered.length === 0 && <p className="text-[13px] text-ink-secondary">{t("market.noSubscriptions")}</p>}
            {ordered.map((subscription) => {
              const usable = usableSubscription(subscription);
              const percent = Math.round(remainingPercent(subscription));
              return (
                <div key={subscription.subscription_id} className="rounded-xl border-[0.5px] border-(--settings-edge) p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[14px] font-medium text-ink">{subscription.plan_title}</div>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px]", usable ? "bg-accent/15 text-accent" : "bg-ink/10 text-ink-secondary")}>
                      {t(STATUS_KEY[subscription.status])}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="mt-1 flex flex-wrap justify-between gap-2 text-[12px] text-ink-secondary">
                    <span>{t("market.remaining", { percent: String(percent) })}</span>
                    <span>{t("market.expires", { date: day(subscription.expires_at) })}</span>
                  </div>
                  {subscription.token === null && <div className="mt-1 text-[12px] text-danger">{t("market.keyMissing")}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {usable && (installed[subscription.subscription_id] && subscription.token !== null
                      ? <span className="inline-flex items-center gap-1 text-[12px] text-accent"><Check size={13} aria-hidden="true" />{t("market.installed")}</span>
                      : <button type="button" className="ui-button ui-button-primary" disabled={busy !== null} onClick={() => void install(subscription)}>
                          {busy === subscription.subscription_id && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                          {busy === subscription.subscription_id ? t("market.installing") : t("market.install")}
                        </button>)}
                    {!usable && <button type="button" className="ui-button ui-button-primary" onClick={() => void bridge.manage()}>{t("market.renew")}</button>}
                    <button type="button" className="ui-button" onClick={() => void bridge.manage()}>{t("market.manage")}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
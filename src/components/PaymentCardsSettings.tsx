import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, Loader2, Plus, Trash2 } from "lucide-react";

import type { LoginBots } from "../../shared/logins";
import type { PaymentCardView } from "../../shared/payment-card";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { addPaymentCard, listPaymentCards, removePaymentCard } from "@/lib/payment-cards";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { LoginBotPicker } from "./LoginForm";
import { Card } from "./SettingsPrimitives";

// Security: a row shows display fields only — the number and CVC are typed once, never read back.
const ROW_BUTTON = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";
const FIELD = "w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";

export function PaymentCardsSettings() {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [cards, setCards] = useState<PaymentCardView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [pan, setPan] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [addBots, setAddBots] = useState<LoginBots>("all");

  const load = async () => { setCards(await listPaymentCards()); };
  useEffect(() => {
    if (!ownerOrAdmin) return;
    load().catch((cause) => setError(cause instanceof Error && cause.message ? cause.message : t("settings.paymentCards.loadError")));
  }, [ownerOrAdmin]);

  if (!ownerOrAdmin) return <Card title={t("settings.paymentCards.title")} subtitle={t("settings.paymentCards.adminOnly")} />;

  const botNames = (value: LoginBots) => {
    if (value === "all") return t("settings.logins.allBots");
    const names = bots.filter((bot) => value.includes(bot.id)).map((bot) => bot.name);
    return names.length ? names.join(", ") : t("settings.logins.noBots");
  };

  const reset = () => { setName(""); setPan(""); setExpiry(""); setCvc(""); setHolder(""); setAddBots("all"); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addPaymentCard({ ...(name.trim() ? { name: name.trim() } : {}), pan, expiry, cvc, ...(holder.trim() ? { holder: holder.trim() } : {}), bots: addBots });
      reset();
      setAdding(false);
      await load();
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.paymentCards.saveError")); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (deleting !== id) { setDeleting(id); return; }
    setBusy(true);
    setError(null);
    try { await removePaymentCard(id); setDeleting(null); await load(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.deleteError")); }
    finally { setBusy(false); }
  };

  return (
    <Card
      title={t("settings.paymentCards.title")}
      subtitle={t("settings.paymentCards.subtitle")}
      actions={
        <button type="button" className="ui-button ui-button-md shrink-0" disabled={cards === null} onClick={() => setAdding(!adding)}>
          <Plus size={14} />{t("settings.paymentCards.add")}
        </button>
      }
    >
      <div className="flex flex-col gap-3" aria-busy={cards === null || busy} data-payment-cards>
        {adding && (
          <form className="flex flex-col gap-2 rounded-lg bg-inset/60 p-3" onSubmit={submit} data-payment-card-form>
            <div className="flex flex-wrap gap-2">
              <input value={pan} onChange={(event) => setPan(event.target.value)} required autoComplete="off" inputMode="numeric" spellCheck={false} maxLength={23}
                aria-label={t("settings.paymentCards.pan")} placeholder={t("settings.paymentCards.pan")} className={`${FIELD} flex-[2]`} />
              <input value={expiry} onChange={(event) => setExpiry(event.target.value)} required autoComplete="off" inputMode="numeric" maxLength={7}
                aria-label={t("settings.paymentCards.expiry")} placeholder={t("settings.paymentCards.expiry")} className={`${FIELD} flex-1`} />
              <input value={cvc} onChange={(event) => setCvc(event.target.value)} required autoComplete="off" inputMode="numeric" maxLength={4} type="password"
                aria-label={t("settings.paymentCards.cvc")} placeholder={t("settings.paymentCards.cvc")} className={`${FIELD} flex-1`} />
            </div>
            <div className="flex flex-wrap gap-2">
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" maxLength={80}
                aria-label={t("settings.paymentCards.name")} placeholder={t("settings.paymentCards.name")} className={`${FIELD} flex-1`} />
              <input value={holder} onChange={(event) => setHolder(event.target.value)} autoComplete="off" maxLength={120}
                aria-label={t("settings.paymentCards.holder")} placeholder={t("settings.paymentCards.holder")} className={`${FIELD} flex-1`} />
            </div>
            <LoginBotPicker value={addBots} onChange={setAddBots} bots={bots} />
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={() => { setAdding(false); reset(); }}>{t("logins.cancel")}</button>
              <button type="submit" className="ui-button ui-button-md ui-button-primary" disabled={busy}>{busy && <Loader2 size={13} className="animate-spin" />}{t("settings.paymentCards.save")}</button>
            </div>
          </form>
        )}
        {cards === null && !error && <p className="text-[12px] text-ink-secondary">{t("settings.vault.loading")}</p>}
        {cards !== null && cards.length === 0 && !adding && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.paymentCards.empty")}</p>}
        {!!cards?.length && (
          <ul className="divide-y divide-hairline/30" data-payment-cards-list>
            {cards.map((card) => (
              <li key={card.id} className="flex min-w-0 items-start gap-2 py-2.5" data-payment-card={card.last4}>
                <CreditCard size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
                <div className="min-w-0 flex-1">
                  <div dir="auto" className="truncate text-[13px] font-medium text-ink">{card.name}</div>
                  <div dir="ltr" className="truncate text-[12px] text-ink-secondary">{card.brand} ····{card.last4} · {String(card.expMonth).padStart(2, "0")}/{card.expYear}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-ink-tertiary">
                    {[botNames(card.bots), card.lastUsedAt ? t("settings.logins.used", { when: relativeTime(card.lastUsedAt) }) : t("settings.logins.neverUsed")].join(" · ")}
                  </div>
                </div>
                <button type="button" className={deleting === card.id ? "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50" : ROW_BUTTON} disabled={busy} onClick={() => void remove(card.id)}
                  aria-label={deleting === card.id ? t("settings.logins.deleteConfirm") : t("settings.paymentCards.deleteFor", { name: card.name })}>
                  <Trash2 size={13} />{deleting === card.id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] leading-relaxed text-ink-tertiary">{t("settings.paymentCards.note")}</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
    </Card>
  );
}

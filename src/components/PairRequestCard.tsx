import { useEffect, useState } from "react";
import { Laptop, X } from "lucide-react";

import { companionBridge } from "@/lib/companion-bridge";
import { companionPairingRoute } from "@/lib/companion-pairing";
import { t } from "@/lib/i18n";
import { phonePairingLink } from "../../shared/pairing-link";

interface PairRequest {
  id: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A signed-in phone asked this computer to connect.
 *
 * The account is only the messenger: nothing is granted until the person in
 * front of this computer clicks Allow. Allowing opens the ordinary pairing
 * window, mints the same link a QR carries — endpoints, encrypted route and all
 * — and hands that link back to the control plane for the waiting phone. That
 * keeps one pairing protocol for scans, codes and account requests alike.
 */
export function PairRequestCard() {
  const [queue, setQueue] = useState<PairRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.ogb?.companionAccount;

  useEffect(() => {
    if (!bridge?.onPairRequest) return;
    return bridge.onPairRequest((requests) => {
      setQueue((current) => {
        const known = new Set(current.map((one) => one.id));
        const fresh = requests.filter((one) => !known.has(one.id));
        return fresh.length === 0 ? current : [...current, ...fresh];
      });
    });
  }, [bridge]);

  const request = queue[0];
  if (!request) return null;

  const next = () => {
    setQueue((current) => current.slice(1));
    setError(null);
  };

  const allow = async () => {
    if (busy || !bridge?.answerPairRequest) return;
    setBusy(true);
    setError(null);
    try {
      // The same window a Scan opens: a code is minted there, and the link below
      // is what carries it to the phone.
      const companion = companionBridge();
      if (!companion) throw new Error(t("pairRequest.failed"));
      const state = await companion.pairing(true);
      const route = companionPairingRoute(state, "local");
      if (!route || !state.pairing?.token) throw new Error(t("pairRequest.noLink"));
      const link = phonePairingLink({
        ...route,
        code: state.e2e?.enabled ? undefined : state.pairing.code,
        token: state.pairing.token,
        name: state.discovery?.name,
        secretPublicKey: state.secretPublicKey,
        e2e: state.e2e?.descriptor,
      });
      await bridge.answerPairRequest(request.id, "allow", link);
      next();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t("pairRequest.failed"));
    } finally {
      setBusy(false);
    }
  };

  const deny = async () => {
    if (busy || !bridge?.answerPairRequest) return;
    setBusy(true);
    try {
      await bridge.answerPairRequest(request.id, "deny", null);
      next();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t("pairRequest.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-label={t("pairRequest.title")}
      data-pair-request-card
      className="glass-popup animate-pop-in fixed bottom-6 right-6 z-[60] flex w-[360px] flex-col gap-3 rounded-2xl p-4 text-ink shadow-xl"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-ink/[0.06]">
          <Laptop size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium leading-5">{t("pairRequest.title")}</div>
          <div className="mt-0.5 truncate text-[13px] text-ink-secondary">
            {t("pairRequest.body", { device: request.deviceName })}
          </div>
        </div>
        <button
          type="button"
          onClick={deny}
          disabled={busy}
          aria-label={t("pairRequest.deny")}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p className="text-[12px] leading-relaxed text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={deny}
          disabled={busy}
          className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.06] disabled:opacity-40"
        >
          {t("pairRequest.deny")}
        </button>
        <button
          type="button"
          onClick={allow}
          disabled={busy}
          className="cursor-pointer rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-card hover:opacity-90 disabled:opacity-40"
        >
          {busy ? t("pairRequest.waiting") : t("pairRequest.allow")}
        </button>
      </div>
    </div>
  );
}

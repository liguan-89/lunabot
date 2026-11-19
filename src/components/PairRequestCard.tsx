import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Laptop } from "lucide-react";

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
 *
 * It is a dialog and not a corner toast. The question is "may this stranger's
 * phone reach this computer", it has a person's name on it, and it waits on the
 * one person who can answer — a card that can be scrolled past, covered by the
 * window it lives in, or mistaken for a notification is how the answer never
 * comes. The system notification (main process) is what finds that person when
 * the window is behind something; this is what they find when they arrive.
 */
export function PairRequestCard() {
  const [queue, setQueue] = useState<PairRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.ogb?.companionAccount;

  const enqueue = (requests: PairRequest[]) => {
    setQueue((current) => {
      const known = new Set(current.map((one) => one.id));
      const fresh = requests.filter((one) => !known.has(one.id));
      return fresh.length === 0 ? current : [...current, ...fresh];
    });
  };

  useEffect(() => {
    if (!bridge?.onPairRequest) return;
    const unsubscribe = bridge.onPairRequest(enqueue);
    // A window that reloaded between the request and the card would otherwise
    // lose it: the server still holds it, so read what is pending once on mount.
    void bridge.pairRequests?.().then(enqueue).catch(() => {});
    return unsubscribe;
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

  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/35 p-6"
      // The question is about this computer, not about whatever is underneath:
      // a click outside must not dismiss it without an answer.
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t("pairRequest.title")}
        data-pair-request-card
        className="glass-popup animate-pop-in flex w-[min(440px,100%)] flex-col gap-4 rounded-2xl p-6 text-ink shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.06]">
            <Laptop size={22} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-6">{t("pairRequest.title")}</h2>
            <p className="mt-1 text-[14px] leading-6 text-ink-secondary">
              {t("pairRequest.body", { device: request.deviceName })}
            </p>
          </div>
        </div>
        {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={deny}
            disabled={busy}
            aria-label={t("pairRequest.deny")}
            className="cursor-pointer rounded-lg px-4 py-2 text-[14px] text-ink-secondary hover:bg-ink/[0.06] disabled:opacity-40"
          >
            {t("pairRequest.deny")}
          </button>
          <button
            type="button"
            onClick={allow}
            disabled={busy}
            className="cursor-pointer rounded-lg bg-ink px-5 py-2 text-[14px] font-medium text-card hover:opacity-90 disabled:opacity-40"
          >
            {busy ? t("pairRequest.waiting") : t("pairRequest.allow")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// A temporary permission the bot proposed (server/permission-grants.ts): the person taps Grant or Refuse, and the
// card is the only place a grant can start — the bot's own calls never write one.
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, type Message } from "@/state/store";
import { ASK_PRIMARY_BUTTON, ASK_QUIET_BUTTON } from "./AskCard";

export function GrantProposal({ threadId, message }: { threadId?: string; message: Message }) {
  const proposal = message.grantProposal;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!proposal) return null;

  const answer = async (value: "granted" | "refused") => {
    if (saving || !threadId) return;
    setSaving(true);
    setError(null);
    try {
      await api("/api/grants/answer", { method: "POST", body: JSON.stringify({ threadId, messageId: message.id, answer: value }) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const until = new Date(proposal.expiresAt).toLocaleString();
  return (
    <div data-grant-proposal className="max-w-[600px] text-[15px] leading-relaxed text-ink">
      <p dir="auto">{t("chat.grantProposal.ask", { until })}</p>
      <p dir="auto" className="mt-1 font-medium">{proposal.text}</p>
      {proposal.answer === undefined ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="grant-proposal-grant"
            onClick={() => void answer("granted")}
            disabled={saving}
            className={ASK_PRIMARY_BUTTON}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : t("chat.grantProposal.grant")}
          </button>
          <button type="button" data-testid="grant-proposal-refuse" onClick={() => void answer("refused")} disabled={saving} className={cn(ASK_QUIET_BUTTON, "my-0")}>
            {t("chat.grantProposal.refuse")}
          </button>
        </div>
      ) : (
        <p dir="auto" className="mt-1 text-[13px] text-ink-secondary">
          {proposal.answer === "granted" ? t("chat.grantProposal.granted", { until }) : proposal.answer === "refused" ? t("chat.grantProposal.refused") : t("chat.grantProposal.expired")}
        </p>
      )}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

import { useState } from "react";
import { Check, Copy, Download, Loader2, RefreshCw, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { ELEVATED_CARD } from "./elevated";

const UPDATE_COMMAND = "claude update";

type Phase =
  | { kind: "ask" }
  | { kind: "updating" }
  | { kind: "updated"; version: string }
  | { kind: "manual" }
  | { kind: "failed"; error: string };

export function ClaudeUpdatePrompt({
  instance,
  onRetry,
}: {
  instance: InstanceInfo;
  onRetry?: () => void;
}) {
  const { refreshInstances } = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const { state: copyState, copy: copyCommand } = useCopyFeedback(UPDATE_COMMAND);
  const copyLabel = t(copyState === "failed" ? "common.copyFailed" : "chat.claudeUpdate.copy");

  const update = () => {
    if (phase.kind === "updating") return;
    setPhase({ kind: "updating" });
    api<{ version: string }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(async ({ version }) => {
        setPhase({ kind: "updated", version });
        await Promise.resolve(refreshInstances()).catch(() => {});
      })
      .catch((error: unknown) =>
        setPhase({ kind: "failed", error: error instanceof Error ? error.message : String(error) }),
      );
  };

  const retry = onRetry && (
    <button
      type="button"
      onClick={onRetry}
      className="flex items-center gap-1.5 rounded-full bg-inset px-3 py-1.5 text-[13px] font-medium text-ink ring-[0.5px] ring-ink/[0.08] hover:bg-ink/[0.09]"
    >
      <RefreshCw size={12} aria-hidden="true" /> {t("chat.retry")}
    </button>
  );

  return (
    <div className={`mt-2 max-w-[560px] rounded-[24px] px-[18px] py-4 text-[13.5px] text-ink ${ELEVATED_CARD}`} role="group" aria-label={t("chat.claudeUpdate.aria")}>
      {phase.kind === "ask" && (
        <>
          <p className="leading-relaxed">{t("chat.claudeUpdate.offer")}</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-hairline/40 pt-3">
            <button
              type="button"
              onClick={() => setPhase({ kind: "manual" })}
              className="rounded-full bg-inset px-3.5 py-1.5 text-[13px] font-medium text-ink ring-[0.5px] ring-ink/[0.08] hover:bg-ink/[0.09]"
            >
              {t("chat.claudeUpdate.myself")}
            </button>
            <button
              type="button"
              onClick={update}
              className="ui-button-primary flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110"
            >
              <Download size={12} aria-hidden="true" /> {t("chat.claudeUpdate.doIt")}
            </button>
          </div>
        </>
      )}
      {phase.kind === "updating" && (
        <p className="flex items-center gap-2 text-ink-secondary" aria-live="polite">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t("chat.claudeUpdate.updating")}
        </p>
      )}
      {phase.kind === "updated" && (
        <>
          <p className="flex items-center gap-1.5 text-success" aria-live="polite">
            <Check size={13} aria-hidden="true" /> {t("engines.claudeUpdated", { version: phase.version })}
          </p>
          {retry && <div className="mt-2">{retry}</div>}
        </>
      )}
      {(phase.kind === "manual" || phase.kind === "failed") && (
        <>
          {phase.kind === "failed" && <p className="mb-1.5 break-words text-danger">{phase.error}</p>}
          <p className="leading-relaxed text-ink-secondary">{t("chat.claudeUpdate.manual")}</p>
          <div className="mt-1.5 flex items-center gap-1 rounded-md bg-inset/60 px-2 py-1 font-mono text-[12px]">
            <span className="flex-1 select-all">{UPDATE_COMMAND}</span>
            <button
              type="button"
              onClick={copyCommand}
              aria-label={copyLabel}
              title={copyLabel}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {copyState === "copied" ? <Check size={13} className="text-success" /> : copyState === "failed" ? <X size={13} className="text-danger" /> : <Copy size={13} />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {retry}
            {phase.kind === "failed" && (
              <button
                type="button"
                onClick={update}
                className="rounded-full border border-hairline/40 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
              >
                {t("chat.claudeUpdate.tryAgain")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** Settings → General on a Team Cloud, next to the away-emails row: the member's own full data export
 * (POST /api/me/export, then the zip it answers). Nothing off a team. */
export function MemberDataExport() {
  const team = Boolean(useStore().state.config?.team);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!team) return null;
  const start = () => {
    setBusy(true);
    setFailed(false);
    void api<{ url: string }>("/api/me/export", { method: "POST", body: "{}", timeoutMs: 120_000 })
      .then((answer) => {
        const link = document.createElement("a");
        link.href = answer.url;
        link.download = "lunabot-my-data.zip";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, () => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <div data-settings-row={t("settings.profile.exportData")} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] text-ink">{t("settings.profile.exportData")}</span>
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="rounded-lg border border-edge px-3 py-1 text-[13px] text-ink hover:bg-fill-secondary disabled:opacity-50"
        >
          {busy ? t("settings.profile.exportDataWorking") : t("settings.profile.exportDataStart")}
        </button>
      </div>
      <div className="text-[12px] text-ink-secondary">{t("settings.profile.exportDataHelp")}</div>
      {failed && <div role="alert" className="text-[12px] text-danger">{t("settings.profile.exportDataError")}</div>}
    </div>
  );
}

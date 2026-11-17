import { useState } from "react";

import { phoneVerifyEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";

/** The one mode a person can pick: on is `log`, which writes the verdict to the activity log and never to the chat. */
export function PhoneVerifyRow() {
  const { state, dispatch } = useStore();
  const on = phoneVerifyEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { phoneVerify: on ? "off" : "log" } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.phoneVerify.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.phoneVerify.title")} subtitle={t("settings.phoneVerify.subtitle")}>
      <div className="flex flex-col items-end gap-1">
        <Switch checked={on} disabled={saving} aria-label={t("settings.phoneVerify.aria")} onClick={toggle} />
        {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
      </div>
    </SettingRow>
  );
}
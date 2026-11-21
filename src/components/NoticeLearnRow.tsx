import { useState } from "react";

import { noticeLearnLevel, type NoticeLearnLevel } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Select } from "./Select";
import { SettingRow } from "./SettingsPrimitives";

const LEVELS: readonly NoticeLearnLevel[] = ["off", "conservative", "balanced", "aggressive"];

/**
 * How far the phone notifications the person shares may feed topics into tasks.
 * The phone's per-app tick list decides what ever leaves the phone; this row is
 * the server's own gate — "off" learns nothing even when notices still arrive.
 */
export function NoticeLearnRow({ simple = false }: { simple?: boolean }) {
  const { state, dispatch } = useStore();
  const level = noticeLearnLevel(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const choose = async (next: NoticeLearnLevel) => {
    if (saving || next === level) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { noticeLearn: next } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.noticeLearn.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.noticeLearn.title")} subtitle={t("settings.noticeLearn.subtitle")}>
      <div className="flex flex-col items-end gap-1">
        <Select
          size="sm"
          variant={simple ? "ghost" : "field"}
          className={simple ? undefined : "w-full max-w-[240px]"}
          value={level}
          disabled={saving}
          aria-label={t("settings.noticeLearn.aria")}
          onChange={(event) => void choose(event.target.value as NoticeLearnLevel)}
        >
          {LEVELS.map((value) => (
            <option key={value} value={value}>{t(`settings.noticeLearn.${value}`)}</option>
          ))}
        </Select>
        {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
      </div>
    </SettingRow>
  );
}

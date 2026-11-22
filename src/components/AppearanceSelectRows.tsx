import { useState } from "react";
import { t } from "@/lib/i18n";
import { AVATAR_STYLE_IDS, applyAvatarStyle, useAvatarStyle } from "@/lib/avatar-style";
import { CHAT_WIDTH_IDS, applyChatWidth, readChatWidth, type ChatWidthId } from "@/lib/chat-width";
import { cn } from "@/lib/cn";
import { FONT_IDS, applyFont, readFont, type FontId } from "@/lib/fonts";
import { parseSidebarToolsLayout, setSidebarToolsLayout, SIDEBAR_TOOLS_LAYOUTS, useSidebarToolsLayout } from "@/lib/sidebar-preferences";
import { PresetFace } from "./PresetFace";
import { SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

export function AvatarStyleRow() {
  const current = useAvatarStyle();
  return (
    <div data-settings-row={t("settings.avatarStyle.title")} className="flex flex-col gap-2.5 py-2">
      <div>
        <div className="text-[13px] font-medium text-ink">{t("settings.avatarStyle.title")}</div>
        <div className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.avatarStyle.subtitle")}</div>
      </div>
      <div role="radiogroup" aria-label={t("settings.avatarStyle.aria")} className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {AVATAR_STYLE_IDS.map((id) => {
          const selected = current === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => applyAvatarStyle(id)}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-center transition",
                selected
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/40 bg-panel/60 text-ink-secondary hover:border-hairline hover:bg-raised hover:text-ink",
              )}
            >
              <PresetFace preset="white" avatarStyle={id} size={32} life="still" className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.08)]" />
              <span className="w-full truncate text-[11px] font-medium leading-tight">
                {t(`settings.avatarStyle.${id}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FontRow() {
  const [current, setCurrent] = useState<FontId>(readFont);
  return (
    <SettingRow title={t("settings.font.title")} subtitle={t("settings.font.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        aria-label={t("settings.font.aria")}
        onChange={(event) => {
          // SAFETY: the options are rendered from FONT_IDS, so the value is always a member.
          const id = event.target.value as FontId;
          applyFont(id);
          setCurrent(id);
        }}
      >
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>{t(`settings.font.${id}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

export function ChatWidthRow() {
  const [current, setCurrent] = useState<ChatWidthId>(readChatWidth);
  return (
    <SettingRow title={t("settings.chatWidth.title")} subtitle={t("settings.chatWidth.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        aria-label={t("settings.chatWidth.aria")}
        onChange={(event) => {
          const id = CHAT_WIDTH_IDS.find((width) => width === event.target.value);
          if (!id) return;
          applyChatWidth(id);
          setCurrent(id);
        }}
      >
        {CHAT_WIDTH_IDS.map((id) => (
          <option key={id} value={id}>{t(`settings.chatWidth.${id}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

export function SidebarToolsLayoutRow() {
  const layout = useSidebarToolsLayout();
  return (
    <SettingRow title={t("sidebar.toolsLayout.title")} subtitle={t("sidebar.toolsLayout.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={layout}
        aria-label={t("sidebar.toolsLayout.chooseAria")}
        onChange={(event) => setSidebarToolsLayout(parseSidebarToolsLayout(event.target.value))}
      >
        {SIDEBAR_TOOLS_LAYOUTS.map((option) => (
          <option key={option} value={option}>{t(`sidebar.toolsLayout.${option}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

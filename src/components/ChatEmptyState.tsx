import { Sparkles } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { READY_BOTS } from "@/lib/ready-bots";
import { BotAvatar } from "./Avatar";
import { HELPER_ASK_KEYS } from "./HelperIntro";
import { RenameTitle } from "./RenameTitle";

function starterPromptsFor(bot: Bot): string[] {
  if (bot.defaultBot) return HELPER_ASK_KEYS.map((key) => t(key));
  const normalized = bot.name.trim().toLowerCase();
  const preset = READY_BOTS.find((candidate) => candidate.name.toLowerCase() === normalized || candidate.id === bot.id);
  if (preset?.tryAsking.length) return preset.tryAsking.slice(0, 3);
  return [];
}

/** A chat with no messages yet: the bot, its name (renamable in Advanced), description, and starter chips. */
export function EmptyChat({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  const starters = starterPromptsFor(bot);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <BotAvatar bot={bot} state="idle" size={64} fallback="preset" life="alive" motion="none" motionKey={0} />
      {!advanced ? <div className="text-[17px] font-semibold text-ink">{bot.name}</div> : <RenameTitle
        value={bot.name}
        onCommit={(name) => {
          if (window.ogb?.remoteClient?.active) {
            void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
              .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
              .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
          } else {
            dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
          }
        }}
        className="text-[17px] font-semibold text-ink"
        inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
      />}
      <div className="max-w-[360px] text-[14px] text-ink-secondary">
        {bot.description || t("chat.emptyPrompt")}
      </div>
      {starters.length > 0 && (
        <div data-empty-starters className="mt-2 flex max-w-[520px] flex-wrap items-center justify-center gap-2">
          {starters.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => dispatch({ type: "send", botId: bot.id, text: prompt, threadId: bot.threadId })}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink/[0.09] bg-surface/85 px-3.5 py-1.5 text-[13px] text-ink-secondary shadow-xs backdrop-blur-sm transition-all hover:border-ink/20 hover:bg-raised hover:text-ink"
            >
              <Sparkles size={12} aria-hidden="true" className="shrink-0 text-accent/80" />
              <span className="truncate">{prompt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

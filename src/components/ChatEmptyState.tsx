import { ArrowUpRight, Compass, Sparkles, Zap } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { READY_BOTS } from "@/lib/ready-bots";
import { BotAvatar } from "./Avatar";
import { HELPER_ASK_KEYS } from "./HelperIntro";
import { RenameTitle } from "./RenameTitle";

const STARTER_ICONS = [Sparkles, Compass, Zap] as const;

function starterPromptsFor(bot: Bot): string[] {
  if (bot.defaultBot) return HELPER_ASK_KEYS.slice(0, 3).map((key) => t(key));
  const normalized = bot.name.trim().toLowerCase();
  const preset = READY_BOTS.find((candidate) => candidate.name.toLowerCase() === normalized || candidate.id === bot.id);
  if (preset?.tryAsking.length) return preset.tryAsking.slice(0, 3);
  return HELPER_ASK_KEYS.slice(0, 3).map((key) => t(key));
}

function botAmbientColor(color: Bot["color"] | undefined): string {
  switch (color) {
    case "green": return "var(--identity-green, var(--color-accent))";
    case "blue": return "var(--identity-blue, var(--color-accent))";
    case "red": return "var(--identity-red, var(--color-accent))";
    case "orange": return "var(--identity-orange, var(--color-accent))";
    case "purple": return "var(--identity-purple, var(--color-accent))";
    case "cyan": return "var(--identity-cyan, var(--color-accent))";
    case "pink": return "var(--identity-pink, var(--color-accent))";
    case "yellow": return "var(--identity-yellow, var(--color-accent))";
    case "teal": return "var(--identity-teal, var(--color-accent))";
    case "coral": return "var(--identity-coral, var(--color-accent))";
    default: return "var(--color-accent)";
  }
}

/** A chat with no messages yet: ambient stage glow, bot identity, and refined Bento starter cards. */
export function EmptyChat({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  const starters = starterPromptsFor(bot);
  const ambient = botAmbientColor(bot.color);

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -z-0 h-[280px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        style={{
          background: `radial-gradient(ellipse at center, color-mix(in srgb, ${ambient} 14%, transparent), transparent 70%)`,
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-3.5">
        <div
          className="relative flex items-center justify-center rounded-full p-1.5 ring-1 ring-ink/[0.08] bg-composer/70 shadow-(--shadow-float) backdrop-blur-md"
        >
          <BotAvatar bot={bot} state="idle" size={64} fallback="preset" life="alive" motion="none" motionKey={0} />
        </div>

        <div className="flex flex-col items-center gap-1.5">
          {!advanced ? (
            <div className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{bot.name}</div>
          ) : (
            <RenameTitle
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
              className="text-[20px] font-semibold tracking-[-0.02em] text-ink"
              inputClassName="rounded-lg bg-inset px-2 py-0.5 text-center text-[20px] font-semibold tracking-[-0.02em]"
            />
          )}
          <div className="max-w-[400px] text-[14px] leading-[1.55] text-ink-secondary">
            {bot.description || t("chat.emptyPrompt")}
          </div>
        </div>

        {starters.length > 0 && (
          <div
            data-empty-starters
            className="mt-4 grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-3"
          >
            {starters.map((prompt, index) => {
              const Icon = STARTER_ICONS[index % STARTER_ICONS.length]!;
              return (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => dispatch({ type: "send", botId: bot.id, text: prompt, threadId: bot.threadId })}
                  className="group flex min-h-[84px] flex-col justify-between gap-2.5 rounded-2xl border border-ink/[0.08] bg-[color-mix(in_srgb,var(--color-composer)_88%,transparent)] p-3.5 text-left shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent),0_4px_14px_-6px_rgb(0_0_0/0.16)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-ink/[0.16] hover:bg-raised/90 hover:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_9%,transparent),0_10px_24px_-10px_rgb(0_0_0/0.24)] active:translate-y-0"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="flex size-6 items-center justify-center rounded-lg bg-ink/[0.06] text-accent transition-colors group-hover:bg-accent/15">
                      <Icon size={13} aria-hidden="true" />
                    </span>
                    <ArrowUpRight
                      size={13}
                      aria-hidden="true"
                      className="text-ink-tertiary opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                    />
                  </div>
                  <span className="line-clamp-2 text-[13px] font-medium leading-[1.45] text-ink/90 group-hover:text-ink">
                    {prompt}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

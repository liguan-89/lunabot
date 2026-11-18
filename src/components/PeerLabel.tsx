import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import type { PeerLine } from "@/lib/peer-message";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

/** The "who asked us" line above a peer request bubble. */
export function PeerLabel({ peer, bots }: { peer: PeerLine; bots: readonly Bot[] }) {
  const author =
    bots.find((b) => b.id === peer.botId) ?? bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.handedTask")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : peer.delivery === "coordinate_bots"
          ? t("chat.peer.requested")
          : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? "happy"}
        size={16}
        fallback="preset"
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-tertiary">· {how}</span>
    </div>
  );
}

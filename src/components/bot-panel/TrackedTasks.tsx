import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Hand } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { openBotThread, useStore, type Bot } from "@/state/store";
import type { TrackedItem } from "../../../shared/wire";
import { CardLabel } from "./rows";

const STATE_ICON = { open: CircleDashed, "needs-you": Hand, done: CheckCircle2 } as const;

function ItemRow({ item, bot }: { item: TrackedItem; bot: Bot }) {
  const { dispatch } = useStore();
  const Icon = STATE_ICON[item.state];
  const linked = item.threadId && item.threadId !== bot.threadId;
  const open = () => {
    if (!linked) return;
    openBotThread(dispatch, bot, item.threadId!, false);
  };
  return (
    <li>
      <button
        type="button"
        data-tracked-item={item.id}
        disabled={!linked}
        onClick={open}
        className={cn("flex w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-left", linked && "hover:bg-ink/[0.04]", item.state === "done" && "opacity-55")}
      >
        <Icon size={15} aria-hidden="true" className={cn("shrink-0", item.state === "needs-you" ? "text-accent-text" : item.state === "done" ? "text-ink-tertiary" : "text-ink-secondary")} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px] font-medium", item.state === "done" ? "text-ink-secondary line-through" : "text-ink")}>{item.title}</span>
          {item.note && <span className="block truncate text-[12px] text-ink-tertiary">{item.note}</span>}
        </span>
        {item.state === "needs-you" && <span className="shrink-0 text-[11px] font-medium text-accent-text">{t("botPanel.tracked.needsYou")}</span>}
      </button>
    </li>
  );
}

export function TrackedTasks({ bot }: { bot: Bot }) {
  const [showDone, setShowDone] = useState(false);
  const items = bot.trackedItems ?? [];
  if (!items.length) return null;
  const open = items.filter((item) => item.state !== "done");
  const done = items.filter((item) => item.state === "done");
  return (
    <section data-panel-card="tracked" aria-label={t("botPanel.tracked.title")}>
      <CardLabel>{t("botPanel.tracked.title")}</CardLabel>
      <ul className="flex flex-col gap-px">
        {open.map((item) => <ItemRow key={item.id} item={item} bot={bot} />)}
      </ul>
      {done.length > 0 && (
        <button
          type="button"
          data-tracked-done
          aria-expanded={showDone}
          onClick={() => setShowDone((openState) => !openState)}
          className="mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
        >
          {showDone ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {t("botPanel.tracked.done", { count: done.length })}
        </button>
      )}
      {showDone && done.length > 0 && (
        <ul className="flex flex-col gap-px">
          {done.map((item) => <ItemRow key={item.id} item={item} bot={bot} />)}
        </ul>
      )}
    </section>
  );
}

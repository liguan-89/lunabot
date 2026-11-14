// The setup offer under a new bot's greeting (server/setup-request.ts): "What should I help you with first?" with a few
// starter chips, then Something else. A pick sends its words, which the server runs as setup at once; Something else is
// answered by the bot's own line, and the next thing the person types is what the bot sets itself up for. While it
// waits, a chip above the message box says so and its x stops it. Once answered, only the answer stays, as one quiet
// line. While its answers are written, at first or after the bot is renamed, it takes no pick.
import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";

import { currentReactor, useReactor } from "@/lib/cloud-guest";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { returnFocusToComposer } from "./AskCard";

const blank = (bot: Pick<Bot, "soul" | "description">): boolean => !bot.soul?.trim() && !bot.description?.trim();
const FALLBACK_CHOICES: LocaleKey[] = [
  "chat.setupCard.research", "chat.setupCard.watch", "chat.setupCard.inbox", "chat.setupCard.errands", "chat.setupCard.data",
];
/** How long the card waits for answers being written after it first sees the wait, and how old a wait can be before it
 * is one a restart left behind: the server ends a wait within 7 s. */
const PENDING_GRACE_MS = 8_000;
const STALE_WAIT_MS = 20_000;
const PLACEHOLDER_WIDTHS = [72, 96, 64];

/** The server closes the card once the bot is given instructions or the card is closed; the bot's own fields and the
 * transcript cover the moments before that reaches this screen. The conversation's AI must have the tools a bot sets
 * itself up with. */
export function SetupOffer({ botId, threadId, message, transcript }: { botId: string; threadId: string; message: Message; transcript: Message[] }) {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitedOut, setWaitedOut] = useState(false);
  const [rewriteWaitedOut, setRewriteWaitedOut] = useState<number | null>(null);
  // A double click lands before the disabled buttons are drawn.
  const sending = useRef(false);
  // The list on screen changes only when a wait the card showed ends, so a pick is always a chip on screen.
  const shown = useRef<{ id: string; choices: string[] } | null>(null);
  const showedWait = useRef(false);
  const waitedOnce = useRef(false);
  const waiting = message.setupChoicesPending === true && !waitedOut && Date.now() - message.at < STALE_WAIT_MS;
  const stamp = message.setupChoicesUpdating;
  const rewriting = stamp !== undefined && rewriteWaitedOut !== stamp && Date.now() - stamp < STALE_WAIT_MS;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaitedOut(true), PENDING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  useEffect(() => {
    if (!rewriting) return;
    const timer = setTimeout(() => setRewriteWaitedOut(stamp), PENDING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [rewriting, stamp]);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (closed || message.setupOffer !== true || !bot) return null;
  const selection = bot.tasks?.find((task) => task.threadId === threadId)?.modelSelection ?? bot.modelSelection;
  const capable = state.instances.find((instance) => instance.instanceId === selection?.instanceId)?.capabilities?.agentsMcp === true;
  // The first line written here settles the card; it is the card's answer when it set the bot up.
  const first = transcript.find((line) => line.role === "user");
  if (first ? !first.setupRequest && !capable : !(blank(bot) && capable)) return null;
  const settled = first !== undefined;
  const answer = first?.setupRequest ? first : undefined;
  // Once a person has written their own first line, the offer has done its job: no answer to show, nothing left to say.
  if (settled && !answer) return null;
  const pending = waiting && !settled;
  const updating = rewriting && !settled;
  if (pending || updating) waitedOnce.current = true;
  if (shown.current?.id !== message.id || (showedWait.current && !pending && !updating)) {
    shown.current = { id: message.id, choices: message.setupChoices?.length ? message.setupChoices : FALLBACK_CHOICES.map((key) => t(key)) };
  }
  showedWait.current = pending || updating;
  const choices = pending ? [] : shown.current!.choices;
  const title = t("chat.setupCard.heading");

  const ask = (text?: string) => {
    if (sending.current || settled) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    void api<{ message?: Message }>(`/api/bots/${botId}/setup-request`, { method: "POST", body: JSON.stringify({ threadId, ...(text ? { text } : {}) }) })
      .then((reply) => {
        // The live update brings the same line; this one stands in if that update is lost.
        if (reply?.message) dispatch({ type: "messageAdded", threadId, message: reply.message });
        returnFocusToComposer();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        sending.current = false;
        setBusy(false);
      });
  };
  const close = () => {
    setClosed(true);
    void api(`/api/bots/${botId}/setup-request`, { method: "DELETE", body: JSON.stringify({ threadId }) }).catch(() => setClosed(false));
  };
  const options = [...choices.map((choice) => ({ label: choice, pick: () => ask(choice) })), { label: t("chat.setupCard.other"), pick: () => ask() }];

  return (
    <section data-setup-card={message.id} aria-label={title} aria-busy={busy || pending || updating || undefined}
      className="w-full max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] pt-1">
      {settled && answer ? (
        <div data-setup-answer="" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-5">
          <span className="shrink-0 text-ink-tertiary">{t("chat.setupCard.answer")}</span>
          <span dir="auto" className="min-w-0 break-words text-ink">{answer.text}</span>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 dir="auto" className="text-[14px] font-semibold leading-5 text-ink">{title}</h3>
              <p dir="auto" className="mt-0.5 text-[12px] leading-4 text-ink-tertiary">{t("chat.setupCard.hint", { name: bot.name })}</p>
            </div>
            <button type="button" onClick={close} aria-label={t("common.close")} title={t("common.close")}
              className="-mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink-secondary">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {pending ? <div data-setup-waiting="" className="mt-2.5 flex flex-wrap gap-1.5">
            {PLACEHOLDER_WIDTHS.map((width) => (
              <span key={width} className="h-7 rounded-full bg-ink/[0.06] motion-safe:animate-pulse" style={{ width }} />
            ))}
          </div> : <div key={choices.join("\n")} data-setup-updating={updating ? "" : undefined}
            className={cn("mt-2.5 flex flex-wrap gap-1.5", updating ? "motion-safe:animate-pulse" : waitedOnce.current && "motion-safe:animate-msg-in")}>
            {options.map((option) => (
              <button key={option.label} type="button" data-ask-choice="" disabled={updating || busy} onClick={option.pick}
                className={cn("max-w-full rounded-full border px-3 py-1.5 text-start text-[13px] leading-4 transition-colors duration-150",
                  updating ? "border-hairline/30 text-ink-tertiary" : "border-hairline/50 text-ink-secondary hover:border-hairline hover:bg-raised hover:text-ink",
                  "disabled:cursor-default")}>
                <span dir="auto" className="break-words">{option.label}</span>
              </button>
            ))}
          </div>}
          {error && <p role="alert" dir="auto" className="mt-1.5 text-[12px] text-danger">{error}</p>}
        </>
      )}
      {settled && answer && error && <p role="alert" dir="auto" className="mt-1 text-[12px] text-danger">{error}</p>}
    </section>
  );
}

/** Waiting here, for this viewer: where people share the place only the presser sees it. `viewer` is read only then,
 * as the viewer's reactor key ("user" where one person uses the place). */
function waiting(bot: Bot | undefined, threadId: string, viewer: () => string): boolean {
  const request = bot?.tasks?.find((task) => task.threadId === threadId)?.setupRequest;
  return Boolean(request && (!request.by || request.by === viewer()));
}

/** The message box's hint while the bot waits to hear what to set itself up for. Read during the composer's render,
 * so it takes the viewer's key without a hook; the chat view subscribes to it, so it is known by then. */
export function setupRequestPlaceholder(bot: Bot | undefined, threadId: string): string | undefined {
  return bot && waiting(bot, threadId, () => currentReactor()) ? t("composer.setupRequest.placeholder", { name: bot.name }) : undefined;
}

/** "Ava is ready to be set up ×" above the message box, while this conversation waits. */
export function SetupRequestChip({ bot, threadId }: { bot: Bot; threadId: string }) {
  return bot.tasks?.find((task) => task.threadId === threadId)?.setupRequest ? <WaitingChip bot={bot} threadId={threadId} /> : null;
}

function WaitingChip({ bot, threadId }: { bot: Bot; threadId: string }) {
  const [stopping, setStopping] = useState(false);
  const viewer = useReactor();
  if (!waiting(bot, threadId, () => viewer)) return null;
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    void api(`/api/bots/${bot.id}/setup-request`, { method: "DELETE", body: JSON.stringify({ threadId }) })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  };
  return (
    <div data-setup-request className="mb-2 flex">
      <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 ps-2.5 pe-1 text-[13px] text-ink">
        <Sparkles size={13} aria-hidden="true" className="shrink-0 text-accent-text" />
        <bdi dir="auto" className="min-w-0 truncate">{t("composer.setupRequest.waiting", { name: bot.name })}</bdi>
        <button type="button" data-setup-request-cancel="" onClick={stop} disabled={stopping}
          aria-label={t("composer.setupRequest.cancel", { name: bot.name })} title={t("composer.setupRequest.cancel", { name: bot.name })}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink">
          <X size={12} />
        </button>
      </span>
    </div>
  );
}

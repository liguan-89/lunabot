import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ListTodo, TriangleAlert } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { isQuestionCard } from "@/lib/question-card";
import type { Bot, Message } from "@/state/store";
import { credentialResumeOutcome } from "../../shared/credential-request";
import { signInOutcome } from "../../shared/sign-in-request";
import type { Asker } from "./AskCard";
import { ELEVATED_CARD } from "./elevated";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals, type Pending } from "./PendingApproval";
import { QuestionCard, decidedByBot } from "./QuestionCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";

export type TodoItem =
  | { kind: "approval"; id: string; messageId: string; message: Message; label: string; danger: boolean; pending: Pending }
  | { kind: "question"; id: string; messageId: string; message: Message; label: string; danger: false }
  | { kind: "secret"; id: string; messageId: string; message: Message; label: string; danger: false }
  | { kind: "signin"; id: string; messageId: string; message: Message; label: string; danger: false };

export function pendingTodoItems(messages: Message[]): TodoItem[] {
  const approvals = pendingApprovals(messages);
  const approvalByMsgId = new Map<string, Pending>();
  for (const item of approvals) {
    approvalByMsgId.set(item.message.id, item);
  }

  const items: TodoItem[] = [];
  for (const m of messages) {
    const approval = approvalByMsgId.get(m.id);
    if (approval) {
      items.push({
        kind: "approval",
        id: approval.requestId,
        messageId: m.id,
        message: m,
        label: approval.message.card?.title || approval.detail || approval.tool,
        danger: Boolean(approval.danger),
        pending: approval,
      });
      continue;
    }

    if (
      m.kind === "options" &&
      m.card?.requestId &&
      isQuestionCard(m.card) &&
      !m.card.answered &&
      !m.card.dismissed &&
      !m.card.expired &&
      !m.card.stopped &&
      !decidedByBot(m.card)
    ) {
      items.push({
        kind: "question",
        id: m.card.requestId,
        messageId: m.id,
        message: m,
        label: m.card.questionRequest?.questions[0]?.question || m.card.subtitle || m.card.title || t("todoTray.kind.question"),
        danger: false,
      });
      continue;
    }

    if (m.kind === "secret" && m.secret && !credentialResumeOutcome(m.secret) && !m.secret.superseded && !m.secret.stopped) {
      items.push({
        kind: "secret",
        id: `secret:${m.id}`,
        messageId: m.id,
        message: m,
        label: m.secret.label,
        danger: false,
      });
      continue;
    }

    if (
      m.kind === "signin" &&
      m.signIn &&
      !signInOutcome(m.signIn) &&
      !m.signIn.answeredInChat &&
      !m.signIn.superseded &&
      !m.signIn.stopped
    ) {
      items.push({
        kind: "signin",
        id: `signin:${m.id}`,
        messageId: m.id,
        message: m,
        label: m.signIn.site,
        danger: false,
      });
    }
  }
  return items;
}

export function ComposerTodoTray({
  messages,
  threadId,
  bot,
  members,
  bots,
  groupBusyBotId,
  onCancelTurn,
}: {
  messages: Message[];
  threadId: string;
  bot?: Bot;
  members?: Bot[];
  bots: readonly Bot[];
  groupBusyBotId?: string | null;
  onCancelTurn: () => void;
}) {
  const items = useMemo(() => pendingTodoItems(messages), [messages]);
  const approvals = useMemo(
    () => items.filter((item): item is Extract<TodoItem, { kind: "approval" }> => item.kind === "approval").map((item) => item.pending),
    [items],
  );
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const prevCountRef = useRef(items.length);

  useEffect(() => {
    if (prevCountRef.current === 0 && items.length > 0) {
      setCollapsed(false);
      setIndex(0);
    } else if (items.length > 0 && index >= items.length) {
      setIndex(items.length - 1);
    }
    prevCountRef.current = items.length;
  }, [items.length, index]);

  if (!items.length) return null;

  const safeIndex = Math.min(index, items.length - 1);
  const current = items[safeIndex]!;
  const hasDanger = items.some((item) => item.danger);

  const resolveBot = (message: Message): Bot | undefined => {
    if (members?.length) {
      return members.find((member) => member.id === message.from?.botId) ?? members.find((member) => member.id === groupBusyBotId) ?? bot;
    }
    return bots.find((one) => one.id === (message.inbox?.from.botId ?? message.from?.botId)) ?? bot;
  };

  const currentBot = resolveBot(current.message);
  const asker: Asker | undefined = currentBot ? { name: currentBot.name, color: currentBot.color } : undefined;

  if (collapsed) {
    return (
      <div className="mb-2 flex justify-start" data-todo-tray="collapsed">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label={t("todoTray.expand")}
          className={cn(
            "flex h-9 max-w-full items-center gap-2 rounded-full px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover",
            ELEVATED_CARD,
            hasDanger && "ring-1 ring-danger/40",
          )}
        >
          {hasDanger
            ? <TriangleAlert size={14} className="shrink-0 text-danger" aria-hidden="true" />
            : <ListTodo size={14} className="shrink-0 text-accent" aria-hidden="true" />}
          <span className="min-w-0 truncate">
            {items.length === 1
              ? t("todoTray.collapsedSingle", { label: current.label })
              : t("todoTray.collapsedSummary", { count: items.length, label: current.label })}
          </span>
          <ChevronUp size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-todo-tray="expanded"
      className={cn(
        "composer-todo-tray mb-1.5 overflow-hidden rounded-t-[20px] rounded-b-[10px] border border-ink/[0.08] bg-[color-mix(in_srgb,var(--color-panel)_92%,var(--color-composer))]",
        ELEVATED_CARD,
        current.danger && "ring-1 ring-danger/35",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-inset/40 px-3.5 py-1.5 text-[12px] text-ink-secondary">
        <div className="flex min-w-0 items-center gap-1.5">
          {hasDanger
            ? <TriangleAlert size={13} className="shrink-0 text-danger" aria-hidden="true" />
            : <ListTodo size={13} className="shrink-0 text-accent" aria-hidden="true" />}
          <span className="font-medium text-ink">
            {items.length > 1 ? t("todoTray.titleCount", { count: items.length }) : t("todoTray.title")}
          </span>
          <span className="rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-[11px] leading-none text-ink-secondary">
            {t(`todoTray.kind.${current.kind}`)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {items.length > 1 && (
            <div className="flex items-center gap-0.5 pr-1">
              <button
                type="button"
                onClick={() => setIndex((prev) => (prev - 1 + items.length) % items.length)}
                aria-label={t("todoTray.prev")}
                className="flex size-6 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-1 text-[11px] tabular-nums text-ink-secondary">
                {t("todoTray.pager", { index: safeIndex + 1, count: items.length })}
              </span>
              <button
                type="button"
                onClick={() => setIndex((prev) => (prev + 1) % items.length)}
                aria-label={t("todoTray.next")}
                className="flex size-6 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            aria-label={t("todoTray.collapse")}
            title={t("todoTray.collapse")}
            className="flex size-6 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
      <div className="max-h-[42vh] overflow-y-auto">
        {current.kind === "approval" ? (
          <PendingApprovalPanel
            key={current.id}
            pending={current.pending}
            botName={currentBot?.name}
            asker={currentBot}
            count={approvals.length}
            index={Math.max(0, approvals.findIndex((a) => a.requestId === current.pending.requestId))}
            locale={activeLocale()}
            actions={
              <PendingApprovalActions
                part="primary"
                pending={current.pending}
                approvals={approvals}
                threadId={threadId}
                bot={currentBot}
                onCancelTurn={onCancelTurn}
              />
            }
            more={
              current.pending.message.inbox
                ? undefined
                : (
                  <PendingApprovalActions
                    part="more"
                    pending={current.pending}
                    approvals={approvals}
                    threadId={threadId}
                    bot={currentBot}
                    onCancelTurn={onCancelTurn}
                  />
                )
            }
          />
        ) : current.kind === "question" ? (
          <div className="p-2">
            <QuestionCard key={current.id} threadId={threadId} asker={asker} message={current.message} />
          </div>
        ) : current.kind === "secret" ? (
          <div className="p-2">
            <SecretRequestCard
              key={current.id}
              botId={currentBot?.id ?? bot?.id ?? ""}
              botName={currentBot?.name}
              color={currentBot?.color}
              threadId={threadId}
              message={current.message}
            />
          </div>
        ) : (
          <div className="p-2">
            <SignInRequestCard
              key={current.id}
              botId={currentBot?.id ?? bot?.id ?? ""}
              botName={currentBot?.name ?? ""}
              color={currentBot?.color}
              threadId={threadId}
              message={current.message}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The quiet row a docked todo leaves behind in the transcript, in place of its card. */
export function dockedTodoAnchor(messageId: string) {
  return (
    <div data-docked-todo-anchor={messageId} className="flex items-center gap-2 px-1 py-1 text-[12px] text-ink-tertiary">
      <span className="size-1.5 rounded-full bg-accent/70" aria-hidden="true" />
      <span>{t("todoTray.dockedHint")}</span>
    </div>
  );
}

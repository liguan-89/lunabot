import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, AudioLines, Camera, ChevronDown, ChevronUp, ExternalLink, Mic, Paperclip, X } from "lucide-react";
import { currentTaskBot, useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { pathForFile } from "./ComposerAttachments";
import { slotColors } from "./composer-simple";
import { intakeFilesWithNotice } from "@/lib/attach-notice";
import { uploadDraftImage } from "@/lib/composer-uploads";
import {
  composeMessage,
  imageBytesLeft,
  imageSlotsLeft,
  type Attachment,
} from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { randomUuid } from "@/lib/random-uuid";
import { cn } from "@/lib/cn";
import { useComposerDictation } from "@/lib/use-composer-dictation";
import type { MausMotion, MausState } from "@/lib/mascot";

export function isReadableMountMessage(msg: Message): boolean {
  if (msg.kind === "digest" || msg.kind === "compaction") return false;
  if (!msg.text?.trim()) return false;
  if (msg.text.trimStart().startsWith("[digest]")) return false;
  return msg.role === "user" || msg.role === "bot";
}

export function recentMountMessages(messages: Message[], limit = 6): Message[] {
  const filtered = messages.filter(isReadableMountMessage);
  return filtered.slice(-limit);
}

export function latestReplySnippet(messages: Message[], limit = 2000): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "bot" || !isReadableMountMessage(msg)) continue;
    const cleaned = (msg.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    if (!cleaned) continue;
    return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1).trimEnd()}…`;
  }
  return "";
}

const GLASS_BUBBLE = cn(
  "relative isolate overflow-hidden rounded-[20px] border border-white/25 dark:border-white/12",
  "bg-card/88 backdrop-blur-2xl text-ink",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(255,255,255,0.12),0_14px_34px_-8px_rgba(0,0,0,0.34),0_3px_10px_-2px_rgba(0,0,0,0.16)]",
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]",
  "before:bg-[radial-gradient(120%_75%_at_16%_0%,rgba(255,255,255,0.28),transparent_62%)] dark:before:bg-[radial-gradient(120%_75%_at_16%_0%,rgba(255,255,255,0.11),transparent_62%)]",
);

export function DesktopMountView({ botId }: { botId?: string | null }) {
  const { state, dispatch } = useStore();
  const profile = useMemo<Bot | undefined>(
    () => (botId ? state.bots.find((candidate) => candidate.id === botId) : undefined) ?? state.bots[0],
    [botId, state.bots],
  );
  const bot = useMemo(() => (profile ? currentTaskBot(profile) : undefined), [profile]);
  const messages = useMemo(() => (bot ? visibleMessages(bot) : []), [bot]);
  const lastReply = useMemo(() => latestReplySnippet(messages), [messages]);
  const threadFeed = useMemo(() => recentMountMessages(messages, 6), [messages]);

  const [expanded, setExpanded] = useState(false);
  const [mascotHovered, setMascotHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [motionBurst, setMotionBurst] = useState<{ kind: MausMotion; key: number }>({ kind: "arrive", key: 1 });

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevReplyRef = useRef(lastReply);

  const draftId = bot ? `mount:${bot.id}:${bot.threadId}` : "mount:default";
  const { recording, ready: micReady, speechError, toggle: toggleMic, stop: stopDictation } = useComposerDictation({
    draftId,
    text,
    onText: setText,
  });
  const engineSupportsImages = Boolean(
    bot && state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.capabilities?.images,
  );
  const uploadImage = useCallback((file: File) => uploadDraftImage(draftId, file), [draftId]);

  const triggerMotion = useCallback((kind: MausMotion) => {
    setMotionBurst((prev) => ({ kind, key: prev.key + 1 }));
  }, []);

  useEffect(() => {
    if (lastReply && lastReply !== prevReplyRef.current) {
      prevReplyRef.current = lastReply;
      triggerMotion("success");
    }
  }, [lastReply, triggerMotion]);

  const syncInteractiveRects = useCallback(() => {
    const bridge = window.ogb?.desktopMount;
    const root = rootRef.current;
    if (!bridge || !root) return;
    const rects = Array.from(root.querySelectorAll<HTMLElement>("[data-mount-interactive]"))
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        x: Math.floor(rect.left),
        y: Math.floor(rect.top),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      }));
    bridge.setInteractiveRects(rects);
  }, []);

  useLayoutEffect(() => {
    syncInteractiveRects();
  }, [syncInteractiveRects, expanded, dragging, attachments.length, lastReply, threadFeed.length, notice, speechError, recording, bot?.id, bot?.busy, bot?.unread]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncInteractiveRects());
    observer.observe(root);
    return () => observer.disconnect();
  }, [syncInteractiveRects]);

  useEffect(() => {
    if (expanded) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [expanded, threadFeed.length]);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setAttaching(true);
    try {
      const { attachments: added, notice: attachNotice } = await intakeFilesWithNotice(Array.from(fileList), {
        allowImages: engineSupportsImages,
        getPath: pathForFile,
        uploadImage,
        imageSlots: imageSlotsLeft(attachments),
        imageBytes: imageBytesLeft(attachments),
      });
      if (added.length) {
        setAttachments((prev) => [...prev, ...added]);
        setExpanded(true);
        triggerMotion("surprise");
      }
      if (attachNotice) setNotice(attachNotice);
    } finally {
      setAttaching(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  };

  const captureScreen = async () => {
    if (attaching || !engineSupportsImages) return;
    const capture = window.ogb?.desktopMount?.captureScreen;
    if (!capture) return;
    setAttaching(true);
    setNotice(null);
    try {
      const result = await capture();
      if (!result.ok || !result.dataUrl) {
        setNotice(result.error ?? "Screen capture failed");
        return;
      }
      const response = await fetch(result.dataUrl);
      const blob = await response.blob();
      const file = new File([blob], result.name ?? `screenshot-${Date.now()}.png`, { type: "image/png" });
      const uploaded = await uploadImage(file);
      if (uploaded) {
        setAttachments((prev) => [...prev, uploaded]);
        setExpanded(true);
        triggerMotion("customize");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setAttaching(false);
    }
  };

  const send = () => {
    if (!bot || attaching) return;
    const composed = composeMessage(text.trim(), attachments);
    if (!composed) return;
    stopDictation();
    dispatch({
      type: "send",
      botId: bot.id,
      threadId: bot.threadId,
      text: composed,
      sendId: randomUuid(),
    });
    setText("");
    setAttachments([]);
    setNotice(null);
    triggerMotion("launch");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape") {
      if (recording) {
        stopDictation();
        return;
      }
      setExpanded(false);
    }
  };

  if (!bot) return null;

  const showPreview = Boolean(lastReply) || bot.busy || bot.unread || expanded;
  const showComposer = expanded || dragging || attachments.length > 0;
  const hasPayload = Boolean(text.trim()) || attachments.length > 0;
  const slot = slotColors(bot.color, false);

  // Map live context to expressive states so both PresetFace hands and 3D Mascot react vividly:
  // - busy -> "working" (rapid typing hands / working orbit)
  // - recording or typing in composer -> "listening" (attentive ear hand)
  // - hovered or unread -> "writing" ("speaking" mood in PresetFace -> waving hand!)
  // - expanded -> "thinking" (chin-tap pondering hand)
  const avatarState: MausState = bot.busy
    ? "working"
    : recording || text.trim().length > 0
      ? "listening"
      : mascotHovered || bot.unread
        ? "writing"
        : expanded
          ? "thinking"
          : "idle";

  return (
    <div
      ref={rootRef}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
      className="flex h-screen w-screen flex-col items-end justify-end gap-2.5 bg-transparent p-3 select-none"
    >
      <style>{`
        @keyframes mount-float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-4px) rotate(1.2deg); }
        }
        @keyframes mount-bubble-in {
          from { opacity: 0; transform: translateY(6px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      {showPreview && (
        <div
          data-mount-interactive
          style={{ animation: "mount-bubble-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both" }}
          className={cn(
            GLASS_BUBBLE,
            "group/bubble flex min-h-0 w-full flex-col text-[12px]",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-2.5 pb-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[12px] font-semibold tracking-tight text-ink/90">{bot.name}</span>
              {bot.busy && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  <span className="size-1.5 rounded-full bg-accent animate-pulse" />
                  {t("chat.activity.working")}
                </span>
              )}
              {!bot.busy && bot.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
            </div>
            <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-ink/[0.04] p-0.5 opacity-75 transition-opacity group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100 touch:opacity-100">
              {window.ogb?.desktopMount?.startCall && (
                <button
                  type="button"
                  onClick={() => {
                    triggerMotion("launch");
                    void window.ogb?.desktopMount?.startCall?.(bot.id);
                  }}
                  title={t("call.turns.callName", { name: bot.name })}
                  aria-label={t("call.turns.callName", { name: bot.name })}
                  className="flex size-5 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/10 hover:text-ink"
                >
                  <AudioLines size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setExpanded((prev) => !prev);
                  triggerMotion("switch");
                }}
                aria-label={expanded ? "Collapse" : "Expand"}
                className="flex size-5 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/10 hover:text-ink"
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </button>
              <button
                type="button"
                onClick={() => void window.ogb?.desktopMount?.openMain(bot.id)}
                title={t("desktopMount.openChat")}
                aria-label={t("desktopMount.openChat")}
                className="flex size-5 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/10 hover:text-ink"
              >
                <ExternalLink size={11} />
              </button>
              <button
                type="button"
                onClick={() => void window.ogb?.desktopMount?.unmount()}
                title={t("desktopMount.unpin")}
                aria-label={t("desktopMount.unpin")}
                className="flex size-5 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/10 hover:text-ink"
              >
                <X size={11} />
              </button>
            </div>
          </div>

          {expanded ? (
            <div
              ref={scrollRef}
              className="flex min-h-0 max-h-[240px] flex-col gap-1.5 overflow-y-auto overscroll-contain px-3.5 pb-3 pt-1 select-text"
            >
              {threadFeed.length === 0 ? (
                <p className="text-[12px] text-ink-tertiary">{t("desktopMount.placeholder", { name: bot.name })}</p>
              ) : (
                threadFeed.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[12px] leading-[1.45]",
                      msg.role === "user"
                        ? "self-end bg-accent text-white shadow-xs"
                        : "self-start bg-ink/[0.06] text-ink",
                    )}
                  >
                    {(msg.text ?? "").trim()}
                  </div>
                ))
              )}
            </div>
          ) : (
            lastReply && (
              <div className="min-h-0 max-h-[280px] overflow-y-auto overscroll-contain px-3.5 pb-3 pt-0.5 select-text">
                <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.48] text-ink/90">
                  {lastReply}
                </p>
              </div>
            )
          )}
        </div>
      )}

      <div className="flex w-full items-center justify-end gap-2.5">
        {showComposer && (
          <div
            data-mount-interactive
            style={{ animation: "mount-bubble-in 160ms cubic-bezier(0.22, 1, 0.36, 1) both" }}
            className={cn(
              GLASS_BUBBLE,
              "flex min-w-0 flex-1 flex-col gap-1 rounded-[22px] px-3.5 py-2",
              dragging && "border-accent ring-2 ring-accent/40",
              recording && !dragging && "ring-1 ring-danger/45",
            )}
          >
            {(attachments.length > 0 || dragging) && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-secondary">
                {dragging && <span className="text-accent">{t("desktopMount.dropHint")}</span>}
                {attachments.map((item) => (
                  <span
                    key={item.id}
                    className="inline-flex max-w-[140px] items-center gap-1 rounded-full bg-ink/[0.08] px-2 py-0.5 text-[11px] text-ink"
                  >
                    <Paperclip size={10} className="shrink-0" />
                    <span className="truncate">{"name" in item ? item.name : item.kind}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((candidate) => candidate.id !== item.id))}
                      className="text-ink-tertiary hover:text-ink"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {(notice || speechError) && <p className="text-[11px] text-warning">{notice ?? speechError}</p>}
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={text}
                onChange={(e) => {
                  if (recording) stopDictation();
                  setText(e.target.value);
                }}
                onKeyDown={onKeyDown}
                placeholder={recording ? t("composer.placeholder.listening") : t("desktopMount.placeholder", { name: bot.name })}
                aria-label={t("desktopMount.placeholder", { name: bot.name })}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
              />
              {engineSupportsImages && window.ogb?.desktopMount?.captureScreen && (
                <button
                  type="button"
                  onClick={() => void captureScreen()}
                  disabled={attaching}
                  title={t("composer.attach")}
                  aria-label={t("composer.attach")}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/10 hover:text-ink disabled:opacity-45"
                >
                  <Camera size={13} />
                </button>
              )}
              {!bot.busy && micReady && (
                <button
                  type="button"
                  onClick={toggleMic}
                  aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
                  title={recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint")}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                    recording
                      ? "animate-pulse bg-danger/20 text-danger"
                      : "text-ink-secondary hover:bg-ink/10 hover:text-ink",
                  )}
                >
                  <Mic size={13} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />
                </button>
              )}
              {!hasPayload && window.ogb?.desktopMount?.startCall ? (
                <button
                  type="button"
                  onClick={() => {
                    stopDictation();
                    triggerMotion("launch");
                    void window.ogb?.desktopMount?.startCall?.(bot.id);
                  }}
                  title={t("call.turns.callName", { name: bot.name })}
                  aria-label={t("call.turns.callName", { name: bot.name })}
                  style={{ backgroundColor: slot.fill, color: slot.ink }}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full shadow-xs transition-transform hover:scale-105 hover:brightness-110 active:scale-95"
                >
                  <AudioLines size={13} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!hasPayload || attaching}
                  aria-label={t("composer.send.message")}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full transition-all",
                    hasPayload && !attaching
                      ? "bg-ink text-app shadow-xs hover:scale-105 active:scale-95"
                      : "bg-ink/[0.08] text-ink-tertiary",
                  )}
                >
                  <ArrowUp size={13} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          data-mount-interactive
          onMouseEnter={() => {
            setMascotHovered(true);
            triggerMotion("blink");
          }}
          onMouseLeave={() => setMascotHovered(false)}
          onClick={() => {
            setExpanded((prev) => !prev);
            triggerMotion("switch");
          }}
          onDoubleClick={() => void window.ogb?.desktopMount?.openMain(bot.id)}
          aria-label={bot.name}
          title={bot.name}
          style={{ animation: "mount-float 3.6s ease-in-out infinite" }}
          className={cn(
            "group relative flex size-[58px] shrink-0 items-center justify-center rounded-full bg-transparent p-0 transition-transform duration-200",
            "hover:scale-110 active:scale-95",
            "drop-shadow-[0_8px_18px_rgba(0,0,0,0.34)]",
          )}
        >
          {bot.busy && (
            <span className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-accent/70 animate-ping" />
          )}
          <span
            className={cn(
              "flex items-center justify-center rounded-full transition-transform duration-200",
              dragging && "scale-110",
            )}
            style={{
              filter:
                "drop-shadow(1.5px 0 0 rgba(255,255,255,0.85)) drop-shadow(-1.5px 0 0 rgba(255,255,255,0.85)) drop-shadow(0 1.5px 0 rgba(255,255,255,0.85)) drop-shadow(0 -1.5px 0 rgba(255,255,255,0.85))",
            }}
          >
            <BotAvatar
              bot={bot}
              size={52}
              fallback="preset"
              life="alive"
              crown={Boolean(bot.chiefOfStaff)}
              state={avatarState}
              motion={motionBurst.kind}
              motionKey={motionBurst.key}
              animated
              trackPointer
            />
          </span>
          {(bot.busy || bot.unread) && (
            <span
              className={cn(
                "absolute right-0.5 top-0.5 size-3.5 rounded-full border-2 border-white shadow-xs",
                bot.busy ? "bg-accent animate-pulse" : "bg-accent",
              )}
            />
          )}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, ExternalLink, Paperclip, X } from "lucide-react";
import { currentTaskBot, useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { pathForFile } from "./ComposerAttachments";
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

export function latestReplySnippet(messages: Message[], limit = 96): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "bot" || !msg.text?.trim()) continue;
    const plain = msg.text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
    if (!plain) continue;
    return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
  }
  return "";
}

export function DesktopMountView({ botId }: { botId?: string | null }) {
  const { state, dispatch } = useStore();
  const profile = useMemo<Bot | undefined>(
    () => (botId ? state.bots.find((candidate) => candidate.id === botId) : undefined) ?? state.bots[0],
    [botId, state.bots],
  );
  const bot = useMemo(() => (profile ? currentTaskBot(profile) : undefined), [profile]);
  const messages = useMemo(() => (bot ? visibleMessages(bot) : []), [bot]);
  const lastReply = useMemo(() => latestReplySnippet(messages), [messages]);

  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const draftId = bot ? `mount:${bot.id}:${bot.threadId}` : "mount:default";
  const engineSupportsImages = Boolean(
    bot && state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.capabilities?.images,
  );
  const uploadImage = useCallback((file: File) => uploadDraftImage(draftId, file), [draftId]);

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
  }, [syncInteractiveRects, expanded, hovered, dragging, attachments.length, lastReply, notice, bot?.id, bot?.busy, bot?.unread]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncInteractiveRects());
    observer.observe(root);
    return () => observer.disconnect();
  }, [syncInteractiveRects]);

  useEffect(() => {
    if (expanded) requestAnimationFrame(() => inputRef.current?.focus());
  }, [expanded]);

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

  const send = () => {
    if (!bot || attaching) return;
    const composed = composeMessage(text.trim(), attachments);
    if (!composed) return;
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
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape") {
      setExpanded(false);
    }
  };

  if (!bot) return null;

  const showPreview = (hovered || expanded) && (Boolean(lastReply) || bot.busy || bot.unread);
  const showComposer = expanded || dragging || attachments.length > 0;
  const hasPayload = Boolean(text.trim()) || attachments.length > 0;

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
      className="flex h-screen w-screen flex-col items-end justify-end gap-2 bg-transparent p-3 select-none"
    >
      {showPreview && (
        <div
          data-mount-interactive
          className="flex w-[288px] flex-col gap-1 rounded-2xl border border-hairline bg-card/95 px-3 py-2 text-[12px] text-ink shadow-lg backdrop-blur-md"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium text-ink">{bot.name}</span>
              {bot.busy && <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse" />}
              {!bot.busy && bot.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void window.ogb?.desktopMount?.openMain(bot.id)}
                title={t("desktopMount.openChat")}
                aria-label={t("desktopMount.openChat")}
                className="flex size-5 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
              >
                <ExternalLink size={12} />
              </button>
              <button
                type="button"
                onClick={() => void window.ogb?.desktopMount?.unmount()}
                title={t("desktopMount.unpin")}
                aria-label={t("desktopMount.unpin")}
                className="flex size-5 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          {lastReply && <p className="line-clamp-2 text-[11px] leading-snug text-ink-secondary">{lastReply}</p>}
        </div>
      )}

      {showComposer && (
        <div
          data-mount-interactive
          className={cn(
            "flex w-[288px] flex-col gap-1 rounded-2xl border bg-card/95 px-2.5 py-1.5 shadow-lg backdrop-blur-md",
            dragging ? "border-accent ring-1 ring-accent/40" : "border-hairline",
          )}
        >
          {(attachments.length > 0 || dragging) && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-secondary">
              {dragging && <span className="text-accent">{t("desktopMount.dropHint")}</span>}
              {attachments.map((item) => (
                <span
                  key={item.id}
                  className="inline-flex max-w-[140px] items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink"
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
          {notice && <p className="text-[11px] text-warning">{notice}</p>}
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("desktopMount.placeholder", { name: bot.name })}
              aria-label={t("desktopMount.placeholder", { name: bot.name })}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
            />
            <button
              type="button"
              onClick={send}
              disabled={!hasPayload || attaching}
              aria-label={t("composer.send.message")}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                hasPayload && !attaching
                  ? "bg-accent text-white hover:opacity-90"
                  : "bg-raised text-ink-tertiary",
              )}
            >
              <ArrowUp size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        data-mount-interactive
        onClick={() => setExpanded((prev) => !prev)}
        onDoubleClick={() => void window.ogb?.desktopMount?.openMain(bot.id)}
        aria-label={bot.name}
        title={bot.name}
        className="relative flex size-13 items-center justify-center rounded-full border border-hairline bg-card/95 shadow-lg backdrop-blur-md transition-transform hover:scale-105 active:scale-95"
      >
        <BotAvatar
          bot={bot}
          size={42}
          state={bot.busy ? "working" : bot.unread ? "happy" : "idle"}
        />
        {(bot.busy || bot.unread) && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-card",
              bot.busy ? "bg-accent animate-pulse" : "bg-accent",
            )}
          />
        )}
      </button>
    </div>
  );
}

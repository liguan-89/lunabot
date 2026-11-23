import { t } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot as BotIcon,
  Keyboard,
  MessageSquare,
  Monitor,
  Palette,
  Pin,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Users,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { api, openBot, useStore, type Bot, type Group } from "@/state/store";
import { rankByName } from "@/lib/palette-rank";
import { useShowThreads } from "@/lib/thread-preferences";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { imeComposing } from "@/lib/send-key";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKINS, type SkinChoice } from "@/lib/skins";
import { matchesWords } from "@/lib/search-words";

interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  keywords: string[];
  shortcut?: string;
  icon: ReactNode;
  run: () => void;
}

type PaletteEntry =
  | { kind: "action"; action: PaletteAction }
  | { kind: "bot"; bot: Bot }
  | { kind: "room"; group: Group }
  | { kind: "message"; hit: SearchHit };

const OPEN_EVENT = "omb:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const advanced = useAdvancedMode();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMessageHits([]);
    setCursor(0);
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      return;
    }
    setMessageHits([]);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => alive && setMessageHits(result.hits ?? []))
        .catch(() => alive && setMessageHits([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  const currentBot = useMemo(
    () => state.bots.find((b) => b.id === state.selectedId && !b.hidden),
    [state.bots, state.selectedId],
  );

  const actions = useMemo<PaletteAction[]>(() => {
    const mac = window.ogb?.platform === "darwin" || /Mac/i.test(navigator.platform);
    const mod = mac ? "⌘" : "Ctrl+";
    const remoteClient = window.ogb?.remoteClient?.active === true;
    const list: PaletteAction[] = [];

    if (currentBot && currentBot.yourAccess !== "view") {
      list.push({
        id: "new-chat",
        label: t("sidebar.newConversationWith", { name: currentBot.name }),
        keywords: ["new chat", "new conversation", "新建对话", "新对话", currentBot.name],
        shortcut: `${mod}⇧N`,
        icon: <SquarePen size={15} className="shrink-0 text-ink-secondary" />,
        run: () => dispatch({ type: "newTask", botId: currentBot.id }),
      });
    }

    list.push({
      id: "new-bot",
      label: t(advanced ? "sidebar.newBot" : "sidebar.newBotSimple"),
      keywords: ["new bot", "create bot", "新建机器人", "创建助手"],
      shortcut: `${mod}N`,
      icon: <BotIcon size={15} className="shrink-0 text-ink-secondary" />,
      run: () => dispatch({ type: "newBot" }),
    });

    if (currentBot && window.ogb?.desktopMount && !remoteClient) {
      list.push({
        id: "mount-desktop",
        label: `${t("desktopMount.pin")} · ${currentBot.name}`,
        keywords: ["mount", "desktop", "pin", "float", "挂载", "桌面", "悬浮球", currentBot.name],
        icon: <Pin size={15} className="shrink-0 text-ink-secondary" />,
        run: () => { void window.ogb?.desktopMount?.mount(currentBot.id); },
      });
    }

    list.push(
      {
        id: "settings-general",
        label: t("settings.title"),
        keywords: ["settings", "preferences", "设置", "偏好"],
        icon: <Settings size={15} className="shrink-0 text-ink-secondary" />,
        run: () => dispatch({ type: "toggleAppSettings", open: true, section: "general" }),
      },
      {
        id: "settings-models",
        label: `${t("settings.title")} · ${t("modelManagement.title")}`,
        keywords: ["models", "ai", "engine", "provider", "api key", "模型", "引擎", "密钥"],
        icon: <SlidersHorizontal size={15} className="shrink-0 text-ink-secondary" />,
        run: () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" }),
      },
      {
        id: "toggle-mode",
        label: `${t("settings.advancedMode.title")} · ${t(advanced ? "mcp.state.off" : "mcp.state.on")}`,
        keywords: ["advanced", "simple", "mode", "高级模式", "简洁模式", "切换模式"],
        icon: <Monitor size={15} className="shrink-0 text-ink-secondary" />,
        run: () => setAdvancedMode(!advanced),
      },
      {
        id: "shortcuts",
        label: t("shortcuts.title"),
        keywords: ["shortcuts", "keyboard", "hotkeys", "快捷键", "键盘"],
        shortcut: "?",
        icon: <Keyboard size={15} className="shrink-0 text-ink-secondary" />,
        run: () => dispatch({ type: "toggleShortcuts", open: true }),
      },
    );

    const quickSkins: Array<{ choice: SkinChoice; label: string; keywords: string[] }> = [
      { choice: "system", label: `${t("settings.theme.title")} · ${t("settings.theme.system")}`, keywords: ["theme", "skin", "system", "auto", "主题", "皮肤", "跟随系统"] },
      ...SKINS.filter((skin) => ["midnight", "daylight", "meadow", "atelier", "foundry", "aurora"].includes(skin.id)).map((skin) => ({
        choice: skin.id as SkinChoice,
        label: `${t("settings.theme.title")} · ${skin.name}`,
        keywords: ["theme", "skin", skin.id, skin.name.toLowerCase(), "主题", "皮肤", skin.id === "daylight" || skin.id === "atelier" || skin.id === "meadow" ? "浅色 light" : "深色 dark"],
      })),
    ];

    for (const skin of quickSkins) {
      list.push({
        id: `skin:${skin.choice}`,
        label: skin.label,
        keywords: skin.keywords,
        icon: <Palette size={15} className="shrink-0 text-ink-secondary" />,
        run: () => applySkinChoice(skin.choice),
      });
    }

    return list;
  }, [advanced, currentBot, dispatch]);

  if (!open) return null;

  const matchedActions = q
    ? actions.filter((action) => matchesWords([action.label, ...action.keywords], q))
    : actions.slice(0, 5);
  const bots = rankByName(state.bots.filter((b) => !b.hidden), q);
  const rooms = rankByName(state.groups, q);
  const entries: PaletteEntry[] = [
    ...bots.map((bot): PaletteEntry => ({ kind: "bot", bot })),
    ...rooms.map((group): PaletteEntry => ({ kind: "room", group })),
    ...matchedActions.map((action): PaletteEntry => ({ kind: "action", action })),
    ...(q ? messageHits.map((hit): PaletteEntry => ({ kind: "message", hit })) : []),
  ];
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;

  const activate = async (entry: PaletteEntry) => {
    if (entry.kind === "action") {
      entry.action.run();
    } else if (entry.kind === "message") {
      const hit = entry.hit;
      try {
        await landOnSearchHit(hit, state, dispatch, showThreads);
      } catch (error) {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } else if (entry.kind === "bot") {
      openBot(dispatch, entry.bot, showThreads);
    } else {
      dispatch({ type: "select", id: entry.group.id });
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (imeComposing(e.nativeEvent)) { e.stopPropagation(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  const roomOffset = bots.length;
  const actionOffset = bots.length + rooms.length;
  const messageOffset = bots.length + rooms.length + matchedActions.length;

  const row = (key: string, index: number, onPick: () => void, children: React.ReactNode, twoLine = false) => (
    <button
      key={key}
      ref={index === selected ? selectedRef : undefined}
      onClick={onPick}
      // mousemove, not mouseenter: rows shifting under a resting pointer must not steal the keyboard selection.
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
        twoLine && "flex-col items-stretch gap-0.5",
        index === selected ? "bg-menu-active" : "hover:bg-menu-hover",
      )}
    >
      {children}
    </button>
  );

  return (
    <div
      className="ui-scrim-light fixed inset-0 z-50 flex items-start justify-center p-6 pt-[14vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        className="popover-surface flex max-h-[min(520px,74vh)] w-full max-w-[580px] flex-col overflow-hidden rounded-[var(--radius-menu)] border border-hairline/50 bg-menu shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("commandPalette.searchLabel")}
            placeholder={t("commandPalette.searchPlaceholder")}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <kbd className="shrink-0 rounded-md border border-hairline/40 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            esc
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {entries.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
              {q ? t("sidebar.noMatch", { query }) : t("palette.empty")}
            </div>
          )}
          {bots.length > 0 && (
            <div className="px-3 pb-1 pt-1.5 text-[12px] font-medium text-ink-tertiary">
              {t("palette.bots")}
            </div>
          )}
          {bots.map((bot, i) =>
            row(
              `bot:${bot.id}`,
              i,
              () => void activate({ kind: "bot", bot }),
              <>
                <BotAvatar bot={bot} state="happy" size={22} fallback="preset" animated={false} />
                <span className="truncate text-[14px] text-ink">{bot.name}</span>
                {bot.title && (
                  <span className="min-w-0 truncate text-[13px] text-ink-secondary">{bot.title}</span>
                )}
              </>,
            ),
          )}
          {rooms.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[12px] font-medium text-ink-tertiary">
              {t("palette.groups")}
            </div>
          )}
          {rooms.map((group, i) =>
            row(
              `room:${group.id}`,
              roomOffset + i,
              () => void activate({ kind: "room", group }),
              <>
                <Users size={16} strokeWidth={1.75} className="mx-[3px] shrink-0 text-ink-secondary" />
                <span className="truncate text-[14px] text-ink">{group.name}</span>
              </>,
            ),
          )}
          {matchedActions.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[12px] font-medium text-ink-tertiary">
              {t("palette.label")}
            </div>
          )}
          {matchedActions.map((action, i) =>
            row(
              `action:${action.id}`,
              actionOffset + i,
              () => void activate({ kind: "action", action }),
              <>
                <span className="flex size-[22px] shrink-0 items-center justify-center">{action.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{action.label}</span>
                {action.shortcut && (
                  <kbd className="shrink-0 rounded-md border border-hairline/40 px-1.5 py-0.5 text-[11px] font-mono text-ink-secondary">
                    {action.shortcut}
                  </kbd>
                )}
              </>,
            ),
          )}
          {q && messageHits.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[12px] font-medium text-ink-tertiary">
              {t("palette.messages")}
            </div>
          )}
          {q &&
            messageHits.map((hit, i) => {
              const before = hit.snippet.slice(0, hit.matchStart);
              const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
              const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
              return row(
                `msg:${hit.threadId}:${hit.messageId}`,
                messageOffset + i,
                () => void activate({ kind: "message", hit }),
                <>
                  <span className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
                    <MessageSquare size={13} className="shrink-0 text-ink-secondary" />
                    {hit.name}
                    {hit.task ? <span className="font-normal text-ink-secondary"> · {hit.task}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-[13px] text-ink-secondary">
                    {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>{after}
                  </span>
                </>,
                true,
              );
            })}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, ClipboardCopy, FolderPlus, Pencil, Plus, TextQuote, Trash2, X } from "lucide-react";
import { formatTime, useStore, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { nextRename } from "@/lib/rename";
import { searchMatchesThreads, useSearchDisclosure } from "@/lib/search-disclosure";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { navigateThreadMenu } from "./BotProjects";
import { useHeldMenuMotion } from "./MenuMotion";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";
import { groupPreview } from "./sidebar-preview";
import { GroupThreadList } from "./SidebarGroupThreadList";
import { RowDot, RowStatusText } from "./SidebarRowMarkers";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";
import { StackedMauses } from "./StackedMauses";

export function GroupListItem({
  group,
  density,
  query = "",
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  query?: string;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`group:${group.id}`, query ?? "", searchMatchesThreads(query ?? "", group.tasks), selected);
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current) setThreadsOpen(true);
    wasSelected.current = selected;
  }, [selected]);
  const hasThreadList = (group.tasks?.length ?? 1) > 1 || Boolean(query);
  const expanded = !group.dm && threadsOpen && density !== "icons" && hasThreadList;
  const simpleRow = !advanced && density === "comfortable";
  const railTile = !advanced && density === "icons";
  const roomBusy = Boolean(group.busyBotId) || Boolean(group.working);
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <>
    <div className={cn("group relative", railTile && "mx-auto w-[54px]")}>
    <button
      data-sidebar-group-row={group.id}
      aria-current={selected && !expanded ? "page" : undefined}
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // The ContextMenu key's native event carries no useful coordinates.
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-md text-left", SIMPLE_ROW_FOCUS,
        density === "icons" ? (railTile ? "h-[54px] justify-center" : "justify-center px-1 py-1.5") : simpleRow
          ? cn("gap-2 rounded-[8px] py-2 pr-2 group-hover:pr-9 group-focus-within:pr-9 max-md:pr-9 touch:pr-9 md:h-[54px] md:py-0", !group.dm && hasThreadList ? "pl-6" : "pl-2") : "gap-2 py-1.5 pl-6 pr-9",
        selected && !expanded ? "bg-raised" : "hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedMauses members={members} density={railTile ? "comfortable" : density} large={simpleRow || railTile} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className={cn("flex items-baseline justify-between gap-2", simpleRow && "pr-7")}>
          <span className={cn("truncate text-[14px] text-ink", simpleRow ? "font-medium leading-5" : "font-semibold")}>{group.name}</span>
          {advanced && selected && last && !expanded && <span className="shrink-0 text-[10px] text-ink-secondary">{formatTime(last.at)}</span>}
          {!simpleRow && expanded && group.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
          {simpleRow && !expanded && group.unread && <RowDot />}
        </div>
        {!expanded && <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-ink-secondary", simpleRow ? "text-[13px] leading-[18px]" : "text-[11px]")}>{group.description || groupPreview(group, state.bots, state.instances, advanced)}</span>
          {!simpleRow && group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>}
        {simpleRow && <RowStatusText unread={group.unread} />}
      </div>
      {density === "icons" && group.unread && (
        <span className={cn("absolute size-2 rounded-full border border-panel bg-accent", railTile ? "right-1 top-1" : "bottom-1.5 right-1.5")} />
      )}
    </button>
    {!group.dm && density !== "icons" && hasThreadList && <button type="button" aria-label={t(expanded ? "task.collapseNamed" : "task.expandNamed", { name: group.name })} aria-expanded={expanded}
      onClick={() => setThreadsOpen((open) => !open)} className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
      <ChevronRight aria-hidden="true" size={12} className={cn("transition-transform", expanded && "rotate-90")} />
    </button>}
    {!group.dm && density !== "icons" && <button type="button" disabled={roomBusy} aria-label={t("task.newShort")} title={t(roomBusy ? "task.newBusy" : "task.newShort")}
      onClick={() => { setThreadsOpen(true); dispatch({ type: "newGroupTask", groupId: group.id }); }}
      className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink disabled:opacity-40 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70 touch:disabled:opacity-40"><Plus size={14} /></button>}
    </div>
    {expanded && <GroupThreadList group={group} selected={selected} query={group.name.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    </>
  );
}

export function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  onDelete,
}: {
  menu: { groupId: string; x: number; y: number } | null;
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = shown ? state.groups.find((g) => g.id === shown.groupId) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState(group?.description ?? "");

  useEffect(() => {
    if (!menu) return;
    setDraft(state.groups.find((g) => g.id === menu.groupId)?.name ?? "");
    setDescriptionDraft(state.groups.find((g) => g.id === menu.groupId)?.description ?? "");
    setRenaming(false);
    setDescribing(false);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!motion.shown || !group || !shown) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const saveDescription = () => {
    const trimmed = descriptionDraft.trim();
    if (trimmed !== (group.description ?? "")) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { description: trimmed } });
    }
    onClose();
  };
  const top = Math.min(shown.y, window.innerHeight - 204);
  const left = Math.min(shown.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      role="menu"
      aria-label={t("sidebar.bot.actions", { name: group.name })}
      onKeyDown={navigateThreadMenu}
      style={{ top, left }}
      className={cn("fixed z-40 w-[228px] overflow-hidden", MENU_SHEET, motion.className)} {...motion.exitProps}
    >
      {!remoteClient && describing ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={descriptionDraft}
            maxLength={120}
            placeholder={t("sidebar.room.descriptionPlaceholder")}
            aria-label={t("sidebar.room.descriptionAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveDescription();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveDescription}
            aria-label={t("sidebar.room.saveDescription")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : !remoteClient && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("sidebar.room.renameAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? t("sidebar.room.saveChatName") : t("sidebar.room.saveChannelName")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? t("sidebar.room.cancelChatRename") : t("sidebar.room.cancelChannelRename")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          role="menuitem"
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? t("sidebar.room.renameChat") : t("sidebar.room.renameChannel")}
        </button>
      ))}
      {!remoteClient && !renaming && !isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            setDescriptionDraft(group.description ?? "");
            setDescribing(true);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <TextQuote size={16} className="text-ink-secondary" />
          {t("sidebar.room.setDescription")}
        </button>
      )}
      {!remoteClient && !isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          {t("sidebar.section.moveToContext")}
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          void copyText(group.threadId);
          onClose();
        }}
        className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      {!remoteClient && <button
        role="menuitem"
        onClick={() => {
          onClose();
          onDelete(group.id);
        }}
        className={cn(MENU_ITEM, "text-danger hover:bg-menu-hover")}
      >
        <Trash2 size={16} />
        {isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel")}
      </button>}
    </div>,
    document.body,
  );
}

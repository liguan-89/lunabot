import { OrganizationIdentity } from "./OrganizationIdentity";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, Bot as BotIcon, FolderPlus, LayoutTemplate, MessageSquarePlus, Plus, Search, SquarePen, Trash2, Users } from "lucide-react";
import { api, useStore, visibleMessages, openBot, openThread, type Bot } from "@/state/store";
import { openBotRow } from "@/state/thread-navigation";
import { cn } from "@/lib/cn";
import { useHeldMenuMotion, useMenuMotion } from "./MenuMotion";
import { botPreview } from "./sidebar-preview";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { ShareTeamDialog, TeamLibraryPanel } from "./lazy-screens";
import { SidebarNewChatPanel } from "./SidebarNewChatPanel";
import { openCommandPalette } from "./CommandPalette";
import { TeamSettingsDialog } from "./TeamSettingsDialog";
import { TeamDialog } from "./TeamDialog";
import { BotProjectDialog, navigateThreadMenu } from "./BotProjects";
import { NewTaskFolderDialog } from "./NewTaskFolderDialog";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useRelativeNow } from "./SidebarThreadRow";
import { setSidebarDensity, useSidebarDensity, usePinnedCircles, useUniversalPins } from "@/lib/sidebar-preferences";
import {
  ATTENTION_SECTION_ID,
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  PINNED_THREADS_SECTION_ID,
  TOOLS_SECTION_ID,
  activeBotsFirst,
  partitionSidebarBots,
  partitionSidebarGroups,
  pinnedCircleThreadListVisible,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  withPrimaryTile,
} from "@/lib/sidebar-layout";
import { useSidebarBotDrag } from "./SidebarBotDrag";
import { useSidebarSections } from "./SidebarSections";
import { departmentNames, moveBotsToSection } from "./bot-sections";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarPhoneBar } from "./SidebarPhoneBar";
import { PhoneHero } from "./SidebarPhoneHero";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { DesktopWorkspaceSwitcher, endCloudHowTo } from "./DesktopWorkspaceSwitcher"; import { PlaceTint } from "./PlaceTint"; import { ChromeRailToggle } from "./ChromeRailToggle";
import { useCloudOwner } from "./CloudOwner";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { NeedsYouButton, OwnerPickerHost, pickOwnerOf } from "./TeamOwner"; import { SidebarPeople } from "./SidebarPeople"; import { SidebarInboxRow } from "./SidebarInboxRow"; import { TeamSideSwitch, useTeamSideLists } from "./TeamSideSwitch"; import { SidebarActiveThreads } from "./SidebarActiveThreads"; import { setAttentionPinned, useAttentionPinned } from "./inbox/attention-pinned"; import { useInboxSupport } from "@/state/inbox";
import { showWhoReportsToWhom, TeamMenuItems } from "./SidebarTeamMenu";
import { MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { ELEVATED_CONTROL } from "./elevated";
import { useTeamPeople } from "@/state/team-people";
export { TeamMenuItems };
import { SidebarResizeHandle, useSidebarWidth } from "./SidebarResizeHandle";
import { PHONE_TOP_BUTTON, SIMPLE_TOP_BUTTON, SidebarSearchPill, SidebarSearchToggle } from "./SidebarSimpleTop";
import { isSidebarToggle } from "@/lib/keyboard-shortcuts";
import { SidebarRailSeparator, SimpleRailFooter } from "./SidebarSimpleRail";
import { useShowThreads } from "@/lib/thread-preferences";
import { attentionHasRunningWork, attentionJumpAction, attentionUnpinAction, crossBotAttentionThreads, crossBotPinnedThreads, sidebarBotActivityTasks, sidebarBotStatus } from "./SidebarBotActivity";
import { SidebarNoBots, SidebarTileGrid } from "./SidebarTiles";
import { BotContextMenu } from "./SidebarBotMenu";
export { BotContextMenu };
import { SidebarAttentionPanel } from "./SidebarAttentionPanel";
import { SidebarPinnedThreadsPanel } from "./SidebarPinnedThreadsPanel";
import { LiveCallPill } from "./LiveCallPill";
import { ShortcutHint } from "./ShortcutHint";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useAdvancedMode } from "@/lib/interface-mode";
import { myDefaultBot, useViewerEmail, useWelcomingBot } from "@/lib/default-bot";
import { PinnedBotRoster, PinnedCircleThreadSection } from "./PinnedCircleThreads";
import { archiveBotWithNotice, onArchiveNotice } from "./bot-archive";
import { ArchivedBotsPanel, botConfirmProps, type BotConfirmKind } from "./ArchivedBotsPanel"; import { MovedBotRows } from "./MoveToTeam";
import { NewRoomPanel } from "./SidebarNewRoomPanel";
import { SectionPicker } from "./SidebarSectionPicker";
import { GroupListItem, RoomContextMenu } from "./SidebarRoomList";
export { GroupListItem };
import { BotListItem, BotThreadList, botRowProps, openBotContextMenu, useVisibleMessages, type BotRowProps, type MenuState } from "./SidebarBotList";
export { BotListItem, BotThreadList, botRowProps, openBotContextMenu, useVisibleMessages, type BotRowProps, type MenuState };

export { PinnedBotCircle, PinnedCircleThreadPanel, PinnedCircleThreadSection } from "./PinnedCircleThreads";
export { ArchivedBotRow, ArchivedBotsPanel, archivedDeleteAllCopy, botConfirmCopy, type BotConfirmKind } from "./ArchivedBotsPanel";
import { roomDeleteCopy } from "./room-delete-copy"; export { roomDeleteCopy };

/** The centre of macOS's traffic lights (14px tall) with the window's frame off, where the window puts them at 16,16. */
export const MAC_TRAFFIC_LIGHT_CENTER_Y = 23;

const SECTION_LABEL_KEYS: Record<string, LocaleKey> = {
  [PINNED_SECTION_ID]: "sidebar.section.pinned",
  [CHANNELS_SECTION_ID]: "sidebar.section.channels",
  [BOT_CHATS_SECTION_ID]: "sidebar.section.botChats",
  [BOTS_SECTION_ID]: "sidebar.section.bots",
};

function sectionLabel(id: string): string {
  const key = SECTION_LABEL_KEYS[id];
  return key ? t(key) : sidebarSectionLabel(id);
}


/** A confirmation may span live fleet updates; never authorize from its snapshot. */
export function currentArchivableBot(bots: readonly Bot[], id: string): Bot | undefined {
  const active = bots.filter((candidate) => !candidate.hidden);
  if (active.length <= 1) return undefined;
  return active.find((candidate) => candidate.id === id && !candidate.chiefOfStaff && !candidate.defaultBot);
}


export function Sidebar({ open, onClose, collapseToIcons = false }: {
  open: boolean;
  onClose: () => void;
  collapseToIcons?: boolean;
}) {
  const { state, dispatch } = useStore();
  const now = useRelativeNow();
  const teamPeople = useTeamPeople();
  const cloudOwner = useCloudOwner(state.config?.cloudHome === true);
  const endHowTo = useCallback(() => endCloudHowTo(dispatch), [dispatch]);
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { capabilities } = useDesktopCapabilities();
  const phone = useMediaQuery(PHONE_LAYOUT, false);
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<{ kind: BotConfirmKind; bot: Bot } | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ botId: string; nonce: number } | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [newTeam, setNewTeam] = useState(false);
  const [teamMenu, setTeamMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [teamSettings, setTeamSettings] = useState<string | null>(null);
  const teamSettingsAllowed = useOwnerOrAdmin();
  const teamMotion = useHeldMenuMotion(teamMenu);
  const teamMenuReturn = useRef<HTMLElement | null>(null);
  const closeTeamMenu = () => {
    (teamMenuReturn.current?.isConnected ? teamMenuReturn.current : sidebarRef.current)?.focus();
    setTeamMenu(null);
  };
  const openTeamMenu = (name: string, x: number, y: number, returnTo: HTMLElement) => {
    teamMenuReturn.current = returnTo;
    setTeamMenu({ name, x: Math.max(8, Math.min(x, window.innerWidth - 266)), y: Math.max(8, Math.min(y, window.innerHeight - 190)) });
  };
  const [deletingTeam, setDeletingTeam] = useState<string | null>(null);
  const [teamDeletePending, setTeamDeletePending] = useState(false);
  const teamDeleteRunning = useRef(false);
  const [moveToTeam, setMoveToTeam] = useState<string | null>(null);
  const [renameTeam, setRenameTeam] = useState<string | null>(null);
  const [shareTeam, setShareTeam] = useState<string | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);
  const deletingRoom = deletingRoomId ? state.groups.find((g) => g.id === deletingRoomId) : undefined;
  const [plusOpen, setPlusOpen] = useState(false);
  const plusMotion = useMenuMotion(plusOpen);
  const advanced = useAdvancedMode();
  const attentionPinned = useAttentionPinned();
  const inboxSupport = useInboxSupport();
  const [newRoom, setNewRoom] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newFolderBotId, setNewFolderBotId] = useState<string | null>(null);
  const [newTaskFolderBotId, setNewTaskFolderBotId] = useState<string | null>(null);
  const newTaskFolderBot = state.bots.find((bot) => bot.id === newTaskFolderBotId);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const storedDensity = useSidebarDensity();
  const density = collapseToIcons ? "icons" : storedDensity;
  const simple = !advanced && density !== "icons";
  const simpleDesk = simple && !phone;
  const rail = !advanced && density === "icons";
  const sidePanelOpen = state.computerOpen || state.inspectorOpen;
  const sizing = useSidebarWidth({ simple: !advanced, sidePanelOpen, sidebarRef });
  const [searchOpen, setSearchOpen] = useState(false);
  const searchShown = searchOpen || query !== "";
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const closeSearch = () => { setSearchOpen(false); setQuery(""); searchToggleRef.current?.focus(); };
  const pinnedCircles = usePinnedCircles();
  const universalPins = useUniversalPins();
  const [pinnedCircleThreadsCollapsed, setPinnedCircleThreadsCollapsed] = useState(true);

  useEffect(() => {
    if (density === "icons") setQuery("");
  }, [density]);

  const toggleCollapsed = () => {
    setSidebarDensity(density === "icons" ? "comfortable" : "icons");
  };
  useEffect(() => {
    if (collapseToIcons || phone) return;
    const onKey = (event: KeyboardEvent) => { if (isSidebarToggle(event)) { event.preventDefault(); toggleCollapsed(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapseToIcons, phone, density]);

  useEffect(() => {
    if (!open || confirm || deletingRoom) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, confirm, deletingRoom]);

  const plusMenuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(plusOpen, plusMenuRef, () => setPlusOpen(false));

  useEffect(() => {
    if (remoteClient) return;
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, [remoteClient]);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);


  const requestArchive = (bot: Bot) => {
    const current = currentArchivableBot(state.bots, bot.id);
    if (current) setConfirm({ kind: "archive", bot: current });
  };

  const archiveBot = async ({ id }: Pick<Bot, "id">) => {
    const bot = currentArchivableBot(state.bots, id);
    if (bot) await archiveBotWithNotice(bot, { bots: state.bots, selectedId: state.selectedId, dispatch, showThreads, notify: setTeamFeedback });
  };
  // Archives from the bot panel report here too, with the same Undo.
  useEffect(() => onArchiveNotice(setTeamFeedback), []);

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      openBot(dispatch, response.bot, showThreads);
      setTeamFeedback({ error: false, text: t("sidebar.archived.restored", { name: bot.name }) });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  // On macOS, where the window's title bar is an inset, the traffic lights sit in the top row's corner.
  const lights = capabilities.windowChrome === "mac-inset";
  const draggableChrome = capabilities.windowChrome !== "native";
  // SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline
  // style.
  const windowDragStyle = draggableChrome
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: interactive buttons must opt out of the draggable title-bar region.
  const windowNoDragStyle = draggableChrome
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();
  const sections = useSidebarSections({ simple, rail, density, query: q, label: sectionLabel, sidebarRef });
  const botDrag = useSidebarBotDrag({ dispatch, announce: sections.announce, onNamed: sections.focusHeader, onRenamed: sections.renamed,
    onError: (text) => setTeamFeedback({ error: true, text }), onCancelled: () => sidebarRef.current?.focus() });

  const sideLists = useTeamSideLists(state), matchingBots = sideLists.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        botPreview(b, visibleMessages(b), state.instances, advanced).toLowerCase().includes(q) ||
        b.tasks?.some((task) => !task.routineRunId && task.title.toLowerCase().includes(q)) ||
        b.projects?.some((folder) => folder.name.toLowerCase().includes(q)),
    );
  const visibleGroups = sideLists.groups.filter((g) => !q || g.name.toLowerCase().includes(q) || g.tasks?.some((task) => task.title.toLowerCase().includes(q)));
  const viewerEmail = useViewerEmail();
  const parts = partitionSidebarBots(botDrag.preview(matchingBots), { universalPins, viewerEmail, welcoming: useWelcomingBot(), searching: Boolean(q) });
  const saved = simpleDesk ? withPrimaryTile(parts, myDefaultBot(state.bots, viewerEmail)?.id) : { ...parts, primary: null };
  // Shown order only: drag and Alt+Up/Down keep working on the saved order, so a reorder never stores this one.
  const { primary, unsectionedChief, pinnedBots, sectionChiefs, sectionedBots, unsectionedBots } = { ...saved, ...activeBotsFirst(saved, (bot) => {
    const { waiting, working } = sidebarBotStatus(bot, state.pendingQueued);
    return waiting || working;
  }) };
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups(visibleGroups);

  const sectionNames: string[] = [...(state.sections ?? []).filter((name) => !q || name.toLowerCase().includes(q.toLowerCase())), ...botDrag.pending];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedRooms) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  const drops = botDrag.arrange({ enabled: (sections.interactive || density === "icons") && !phone, withinList: density === "icons", main: saved.unsectionedBots, sectioned: saved.sectionedBots, departments: sectionNames, bots: state.bots, taken: departmentNames(state) });
  const naturalSectionIds = [
    ...(pinnedBots.length > 0 && !universalPins && !simpleDesk ? [PINNED_SECTION_ID] : []),
    ...(unsectionedRooms.length > 0 ? [CHANNELS_SECTION_ID] : []),
    ...(botChats.length > 0 ? [BOT_CHATS_SECTION_ID] : []),
    ...(unsectionedBots.length > 0 || drops.slot ? [BOTS_SECTION_ID] : []),
    ...sectionNames.map(userSectionId),
  ];
  const layout = sections.arrange(naturalSectionIds);
  const sectionIds = layout.sectionIds;
  const showPinnedCircleThreads = !simpleDesk && pinnedCircleThreadListVisible(pinnedCircles, density, pinnedBots.length);
  const tiles = simpleDesk && (primary !== null || pinnedBots.length > 0);
  const { interactive: layoutInteractive, collapsed: sectionCollapsed, toggle: toggleSection } = sections;
  const archivedBots = state.bots.filter((bot) => bot.hidden && !bot.movedTo);
  const archivedEntry = remoteClient ? undefined : { count: archivedBots.length, open: () => setArchivedBotsOpen(true) };
  const attention = crossBotAttentionThreads(state.bots, state.pendingQueued, undefined, state.groups);
  const pinnedThreads = crossBotPinnedThreads(state.bots, state.groups, state.pendingQueued);
  const pendingBotUndo = teamFeedback?.restoreBot;
  const botRow = (bot: Bot) => botRowProps(state, dispatch, bot, { density, query: q, onMenu: setMenu, renameRequest: renameRequest?.botId === bot.id ? renameRequest.nonce : 0, ...drops.row(bot.id) });
  const railSearch = () => {
    if (collapseToIcons) return openCommandPalette();
    setSearchOpen(true);
    toggleCollapsed();
  };
  const plusItem = cn(MENU_ITEM, "text-ink hover:bg-menu-hover"), plusBot = state.activeView === "chat" ? state.bots.find((candidate) => candidate.id === state.selectedId) : undefined;
  const plusControl = (
    <div ref={plusMenuRef} className="contents">
    <button
      ref={importReturnRef}
      onClick={() => setPlusOpen((o) => !o)}
      aria-label={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
      className={phone ? PHONE_TOP_BUTTON : rail || simple ? SIMPLE_TOP_BUTTON : cn(
        "flex items-center justify-center text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        density === "icons" ? "size-[46px] shrink-0 rounded-xl" : "size-8 rounded-full",
      )}
      title={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")}
    >
      <Plus size={phone || simple || density === "icons" ? 20 : 18} strokeWidth={phone ? 2 : 1.5} />
    </button>
    {plusMotion.shown && (
      <>
        <div role="menu" aria-label={remoteClient ? t("sidebar.new") : t("sidebar.newOrShare")} onKeyDown={navigateThreadMenu} className={cn(
          "absolute z-40 w-max min-w-[200px] overflow-hidden", MENU_SHEET,
          rail ? "left-full top-0 ml-4" : cn("top-full", advanced ? "mt-1" : "mt-1.5", density === "icons" ? "left-0" : "right-0"),
          plusMotion.className,
        )} {...plusMotion.exitProps}>
          {advanced && <button
            onClick={() => {
              setPlusOpen(false);
              setNewChatOpen(true);
            }}
            role="menuitem"
            className={plusItem}
          >
            <MessageSquarePlus size={16} className="text-ink-secondary" />
            {t("sidebar.newChat.title")}
          </button>}
          {!advanced && plusBot && <><button role="menuitem" className={plusItem} onClick={() => { setPlusOpen(false); dispatch({ type: "newTask", botId: plusBot.id }); }}><SquarePen size={16} className="text-ink-secondary" />{t("sidebar.newConversationWith", { name: plusBot.name })}</button><div role="separator" className={MENU_ITEM_SEPARATOR} /></>}
          {teamSettingsAllowed !== false && <button
            onClick={() => { setPlusOpen(false); dispatch({ type: "newBot" }); }}
            role="menuitem"
            className={plusItem}
          >
            <BotIcon size={16} className="text-ink-secondary" />
            <span className="flex-1">{advanced ? t("sidebar.newBot") : t("sidebar.newBotSimple")}</span>
            {advanced && <ShortcutHint id="new-bot" />}
          </button>}
          <button
            onClick={() => {
              setPlusOpen(false);
              setNewRoom(true);
            }}
            role="menuitem"
            className={plusItem}
          >
            <Users size={16} className="text-ink-secondary" />{t("sidebar.newChannel.title")}
          </button>
          {advanced && !remoteClient && teamSettingsAllowed !== false && <button
            onClick={() => { setPlusOpen(false); setNewTeam(true); }}
            role="menuitem"
            className={plusItem}
          >
            <FolderPlus size={16} className="text-ink-secondary" /> {t("team.create")}
          </button>}
          {!remoteClient && <>
          {teamSettingsAllowed !== false && <button
            onClick={() => { setPlusOpen(false); setTeamLibraryOpen(true); }}
            role="menuitem"
            className={plusItem}
          >
            <LayoutTemplate size={16} className="text-ink-secondary" />
            {t("sidebar.teamLibrary")}
          </button>}
          {advanced && archivedBots.length > 0 && (
            <button
              onClick={() => {
                setPlusOpen(false);
                setArchivedBotsOpen(true);
              }}
              role="menuitem"
              className={plusItem}
            >
              <Archive size={16} className="text-ink-secondary" />
              <span className="flex-1">{t("sidebar.archived.title")}</span>
              <span className="text-[12px] text-ink-secondary">{archivedBots.length}</span>
            </button>
          )}
          </>}
        </div>
      </>
    )}
    </div>
  );

  return (
    <aside
      ref={sidebarRef} data-sidebar-root={!phone || open ? "" : undefined}
      tabIndex={-1}
      aria-label={t("sidebar.aria")}
      data-native-view-overlay
      data-sidebar
      onClick={(event) => {
        // The phone's list covers the whole screen: choosing the bot that is already open has to dismiss it too.
        if (phone && open && event.target instanceof Element && !(event.target instanceof HTMLInputElement) && event.target.closest("[data-sidebar-bot-row], [data-sidebar-hero]")) onClose();
      }}
      style={{ "--sidebar-width": `${sizing.width}px` } as CSSProperties}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r-[0.5px] border-edge bg-panel max-md:[--scroll-fade-surface:var(--color-app)]",
        sizing.resizing && !sizing.snapping ? "transition-none" : "transition-[width] duration-200 motion-reduce:transition-none",
        density === "icons" ? rail ? "w-[92px]" : "w-[80px]" : advanced ? "w-[320px] md:w-[var(--sidebar-width)]" : "w-[280px] md:w-[var(--sidebar-width)]",
        sidePanelOpen ? advanced ? "md:max-w-[320px]" : "md:max-w-[280px]" : "md:max-w-[calc(100vw-320px)]",
        // max-md: rather than an md: cancel: Tailwind v4 emits the native `translate`, and any value but `none` makes
        // this a containing block for its `fixed` descendants.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-full max-md:bg-app",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      <GlassScrollFrame className="flex-1" fade><PlaceTint />
      <GlassBar edge="top">
      <div
        data-sidebar-top-row
        className={cn(
          "flex items-center",
          density === "icons" ? "flex-col gap-1 px-2 pt-3.5 pb-1" : simpleDesk ? "@container/sidebar-bar relative h-[60px] items-start pl-4 pr-4 pt-3" : "relative pl-4 pr-2",
          density !== "icons" && !simpleDesk && !lights && "h-12 max-md:h-16",
        )}
        style={density !== "icons" && lights && !simpleDesk ? { ...windowDragStyle, height: MAC_TRAFFIC_LIGHT_CENTER_Y * 2 } : windowDragStyle}
      >
        {phone ? (
          <div className="shrink-0" style={windowNoDragStyle}><SidebarProfileMenu iconOnly circle /></div>
        ) : lights ? (
          // The traffic lights span 16-76px of the window; nothing clickable starts before 88px.
          <div aria-hidden="true" data-traffic-light-space className={density === "icons" ? "h-5 w-full" : "w-[72px] shrink-0"} />
        ) : null}{!phone && <ChromeRailToggle advanced={advanced} icons={density === "icons"} style={windowNoDragStyle} />}
        {rail && <div data-sidebar-rail-top className="flex flex-col items-center gap-2 pt-1" style={windowNoDragStyle}>
          <button type="button" onClick={railSearch} aria-label={t("sidebar.searchAria")} title={t("sidebar.searchAria")} className={SIMPLE_TOP_BUTTON}>
            <Search size={18} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <div className="relative flex">{plusControl}</div>
        </div>}
        {density !== "icons" && (simpleDesk ? <div data-sidebar-top-slot className="min-w-2 flex-1" /> : (
          <div data-sidebar-top-slot className={cn("@container/sidebar-top flex min-w-0 flex-1 items-center", simple && "justify-end")}>
            {!simple && <div data-sidebar-top-spacer className="min-w-0 flex-1 @min-[96px]/sidebar-top:min-w-6" />}
            <div data-sidebar-top-switcher className={simple ? "flex min-w-0 items-center" : "flex min-w-0 max-w-[140px] items-center"}>
              <DesktopWorkspaceSwitcher inline pill={simple} cloudHome={state.config?.cloudHome === true} place={state.config?.team?.name} owner={cloudOwner} howTo={state.cloudHowTo} onMenuClosed={endHowTo} />
            </div>
          </div>
        ))}
        {!rail && <div
          data-sidebar-top-buttons
          className={cn("relative flex shrink-0 items-center", density === "icons" ? "flex-col gap-1" : simpleDesk ? "gap-2" : simple ? "gap-1 pl-0.5" : "ml-0.5 gap-0.5")}
          style={windowNoDragStyle}
        >
          {simpleDesk && <SidebarSearchToggle ref={searchToggleRef} open={searchShown} onToggle={() => (searchShown ? closeSearch() : setSearchOpen(true))} />}
          {density === "icons" && <button
            type="button"
            onClick={openCommandPalette}
            aria-label={t("sidebar.searchAria")}
            title={t("sidebar.searchAria")}
            className="flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Search size={20} strokeWidth={1.5} />
          </button>}
          {advanced && inboxSupport === "no" && <SidebarActiveThreads entries={attention} icons={density === "icons"} phone={phone} dispatch={dispatch} />}
          {simple && !phone && !q && <SidebarInboxRow compact running={attentionHasRunningWork(attention)} />}
          {plusControl}
        </div>}
      </div>

      {density === "icons" && !rail && <DesktopWorkspaceSwitcher compact cloudHome={state.config?.cloudHome === true} place={state.config?.team?.name} owner={cloudOwner} howTo={state.cloudHowTo} onMenuClosed={endHowTo} />}
      <OrganizationIdentity compact={density === "icons"} />
      {phone ? null : simple ? searchShown && <SidebarSearchPill query={query} onQuery={setQuery} onClose={closeSearch} /> : <div className={cn("pt-1 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className={cn("flex h-8 items-center gap-2 rounded-full px-3 focus-within:ring-focus", ELEVATED_CONTROL)}>
          <Search size={15} className="shrink-0 text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={t("sidebar.search")}
            aria-label={t("sidebar.searchAria")}
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
          />
        </div>
      </div>}
      {!q && <TeamSideSwitch compact={density === "icons"} listOnly={phone} />}{!q && (!simple || phone) && <SidebarInboxRow icons={density === "icons"} large={!advanced} running={attentionHasRunningWork(attention)} onOpened={phone ? onClose : undefined} />}
      {universalPins && pinnedBots.length > 0 && !simpleDesk && (
        <div
          data-sidebar-universal-pins=""
          // vh, not %: a percentage has no height to resolve against inside the glass head.
          className="max-h-[min(40vh,280px)] shrink-0 overflow-y-auto border-b border-hairline/40 px-2 pb-2"
        >
          {density !== "icons" && !pinnedCircles && (
            <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              {t("sidebar.section.pinned")}
            </div>
          )}
          <PinnedBotRoster
            bots={pinnedBots}
            density={density}
            circles={pinnedCircles}
            row={botRow}
            listItem={BotListItem}
          />
        </div>
      )}

      {attentionPinned && density !== "icons" && (
        <SidebarAttentionPanel
          entries={attention}
          onUnpin={() => setAttentionPinned(false)}
          onJump={(entry) => dispatch(attentionJumpAction(entry))}
          collapsed={sectionCollapsed(ATTENTION_SECTION_ID)}
          onToggle={layoutInteractive ? () => toggleSection(ATTENTION_SECTION_ID) : undefined}
        />
      )}

      {density !== "icons" && (
        <SidebarPinnedThreadsPanel
          entries={pinnedThreads}
          now={now}
          onJump={(entry) => dispatch(attentionJumpAction(entry))}
          onUnpin={(entry) => dispatch(attentionUnpinAction(entry))}
          collapsed={sectionCollapsed(PINNED_THREADS_SECTION_ID)}
          onToggle={layoutInteractive ? () => toggleSection(PINNED_THREADS_SECTION_ID) : undefined}
        />
      )}
      {tiles && <SidebarTileGrid primary={primary} pinned={pinnedBots} row={botRow} />}
      {simpleDesk && !tiles && <SidebarNoBots />}
      </GlassBar>

      {!collapseToIcons && !phone && <SidebarResizeHandle sizing={sizing} sidebarRef={sidebarRef} avatars={density === "icons"} avatarsWidth={rail ? 92 : 80}
        onAvatars={(avatars) => setSidebarDensity(avatars ? "icons" : "comfortable")} style={windowNoDragStyle} />}

      <GlassScroller className={rail ? "[scrollbar-gutter:stable_both-edges]" : simpleDesk ? "px-3" : "px-2"}>
        <div className={cn("flex flex-col", simpleDesk ? cn("gap-0.5 pb-2", !tiles && "pt-2") : advanced ? "gap-0.5" : "gap-1 pb-2 pt-2")}>
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">{t("sidebar.noMatch", { query })}</div>
          )}
          {!q && <NeedsYouButton compact={rail} />}{!q && <SidebarPeople compact={rail} onOpened={phone ? onClose : undefined} />}
          {unsectionedChief && (phone ? (
            <PhoneHero bot={unsectionedChief} selected={botRow(unsectionedChief).selected} onOpen={() => openBotRow(dispatch, unsectionedChief, showThreads, botRow(unsectionedChief).selected)} onMenu={setMenu} />
          ) : (
            <div className="mb-1.5">
              <BotListItem {...botRow(unsectionedChief)} />
            </div>
          ))}
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const sectionChiefItems = sectionName
              ? sectionChiefs.filter((bot) => bot.section === sectionName)
              : [];
            const sectionGroupItems =
              id === CHANNELS_SECTION_ID
                ? unsectionedRooms
                : id === BOT_CHATS_SECTION_ID
                  ? botChats
                  : sectionName
                    ? sectionedRooms.filter((group) => group.section === sectionName)
                    : [];
            const sectionBotItems =
              id === PINNED_SECTION_ID
                ? pinnedBots
                : id === BOTS_SECTION_ID
                  ? unsectionedBots
                  : sectionName
                    ? sectionedBots.filter((bot) => bot.section === sectionName)
                    : [];
            const headless = simple && id === BOTS_SECTION_ID && index === 0;
            const collapsed = !headless && sectionCollapsed(id);
            const queued = collapsed ? [...sectionChiefItems, ...sectionBotItems].flatMap((bot) =>
              sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.queued).map((task) => `${bot.name}: ${task.title}`)) : [];
            const attention = collapsed
              ? sidebarSectionAttention(
                  [...sectionChiefItems, ...sectionBotItems],
                  sectionGroupItems,
                )
              : undefined;
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                {...drops.zone(id, layout.zone(id))}
                className={cn(
                  "flex flex-col",
                  advanced || simpleDesk ? "gap-0.5" : "gap-1",
                  density !== "icons" && index > 0 && !simple && "pt-3",
                )}
              >
                {rail && index > 0 && <SidebarRailSeparator />}
                {layout.dropLine(id, "before")}
                {density !== "icons" && !headless && (
                  <SidebarSectionHeader
                    name={sectionLabel(id)}
                    line={simple} reserveMenu={simple && !remoteClient}
                    count={simple ? sectionChiefItems.length + sectionBotItems.length + sectionGroupItems.length : undefined}
                    onMenu={simple && !remoteClient && sectionName ? (button) => {
                      const rect = button.getBoundingClientRect();
                      openTeamMenu(sectionName, rect.right - 256, rect.bottom + 4, button);
                    } : undefined}
                    menuOpen={teamMenu !== null && teamMenu.name === sectionName}
                    onContextMenu={!remoteClient && layoutInteractive && sectionName ? (event) => {
                      event.preventDefault();
                      openTeamMenu(sectionName, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget);
                    } : undefined}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    {...layout.header(id)} naming={drops.naming(sectionName)} dropInto={drops.into(sectionName)}
                    onDelete={!simple && !remoteClient && sectionName ? () => setDeletingTeam(sectionName) : undefined}
                  />
                )}
                {collapsed && queued.length > 0 && <button type="button" onClick={() => toggleSection(id)}
                  title={`${t("task.queued")} · ${queued.join(", ")}`} aria-label={`${t("sidebar.section.expand", { name: sectionLabel(id) })} · ${t("task.queued")} · ${queued.join(", ")}`}
                  className="mx-3 mb-1 inline-flex h-7 items-center self-start rounded-full bg-raised/50 px-3 text-[13px] font-medium leading-4 text-ink-secondary hover:text-ink">{t("task.queued")} · {queued.length}</button>}
                {!collapsed && (
                  <>
                    {id === BOTS_SECTION_ID && drops.slot}
                    {sectionChiefItems.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} />)}
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        group={group}
                        density={density}
                        query={q}
                        onMenu={setRoomMenu}
                      />
                    ))}
                    {id === PINNED_SECTION_ID ? (
                      <PinnedBotRoster
                        bots={sectionBotItems}
                        density={density}
                        circles={pinnedCircles}
                        row={botRow}
                        listItem={BotListItem}
                      />
                    ) : sectionBotItems.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} />)}
                    {!remoteClient && sectionName && layoutInteractive && !drops.naming(sectionName) && (!simple || sectionChiefItems.length + sectionGroupItems.length + sectionBotItems.length === 0) && (
                      <button onClick={() => setMoveToTeam(sectionName)} aria-label={t(state.bots.some(bot => !bot.hidden && bot.section?.trim() === sectionName) ? "team.manageBotsIn" : "team.addBotsTo", { name: sectionName })}
                        className="mx-3 my-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink">
                        <Plus size={13} /> {t(state.bots.some(bot => !bot.hidden && bot.section?.trim() === sectionName) ? "team.manageBots" : "team.addBots")}
                      </button>
                    )}
                  </>
                )}
                {layout.dropLine(id, "after")}
              </div>
            );
          })}
          <MovedBotRows bots={state.bots} /><SearchResults query={query} onLanded={() => { setQuery(""); setSearchOpen(false); }} />
          {showPinnedCircleThreads && (
            <PinnedCircleThreadSection
              bots={pinnedBots}
              collapsed={pinnedCircleThreadsCollapsed}
              onToggle={() => setPinnedCircleThreadsCollapsed((collapsed) => !collapsed)}
              row={botRow}
            />
          )}
        </div>
      </GlassScroller>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {sections.announcement}
      </p>

      <GlassBar edge="bottom">
      <LiveCallPill
        currentBotId={state.activeView === "chat" ? state.selectedId : null}
        onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state, showThreads)}
        iconOnly={density === "icons"}
      />

      {rail ? <SimpleRailFooter
        owner={cloudOwner}
        archived={archivedEntry}
      /> : phone ? <SidebarPhoneBar query={query} onQuery={setQuery} /> : <SidebarFooter density={density} simple={simpleDesk} owner={cloudOwner} archived={archivedEntry} toolsCollapsed={sectionCollapsed(TOOLS_SECTION_ID)} onToggleTools={layoutInteractive ? () => toggleSection(TOOLS_SECTION_ID) : undefined} />}
      </GlassBar>
      </GlassScrollFrame>

      <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={requestArchive}
          onDelete={(bot) => setConfirm({ kind: "delete", bot })}
          onMoveToSection={(botId) => {
            if (!menu) return;
            setSectionPicker({ botId, x: menu.x, y: menu.y });
          }}
          onNewFolder={setNewFolderBotId}
          onNewTaskFolder={setNewTaskFolderBotId}
          onRename={(botId) => setRenameRequest((current) => ({ botId, nonce: (current?.nonce ?? 0) + 1 }))}
          onNewSection={density === "icons" ? undefined : (botId) => botDrag.startNew([botId])}
        />
      {showThreads && newFolderBotId && state.bots.find((bot) => bot.id === newFolderBotId) && <BotProjectDialog bot={state.bots.find((bot) => bot.id === newFolderBotId)!} onClose={() => setNewFolderBotId(null)} />}
      {showThreads && newTaskFolderBot && <NewTaskFolderDialog bot={newTaskFolderBot} onClose={() => setNewTaskFolderBotId(null)} onReturnFocus={() => {
        sidebarRef.current?.querySelector<HTMLElement>(`[data-sidebar-bot-row="${CSS.escape(newTaskFolderBot.id)}"]`)?.focus();
      }} />}
      <ConfirmDialog {...botConfirmProps(confirm, state.bots, { archive: (bot) => { setConfirm(null); void archiveBot(bot); }, remove: (bot) => { setConfirm(null); dispatch({ type: "deleteBot", botId: bot.id }); },
        archiveInstead: (chief) => { setConfirm(null); void archiveBotWithNotice(chief, { bots: state.bots, selectedId: state.selectedId, dispatch, showThreads, notify: setTeamFeedback }); } })}
        onCancel={cancelConfirm} returnFocusRef={sidebarRef} />
      <OwnerPickerHost />
      {newTeam && <TeamDialog onClose={() => setNewTeam(false)} />}
      {renameTeam && <TeamDialog section={renameTeam} rename onRenamed={sections.renamed} onClose={() => setRenameTeam(null)} />}
      {teamMotion.shown && teamMotion.value && createPortal(<div className={cn("fixed inset-0 z-40", teamMotion.closing && "pointer-events-none")} onMouseDown={closeTeamMenu}>
        <div role="menu" aria-label={teamMotion.value.name} style={{ left: teamMotion.value.x, top: teamMotion.value.y }}
          className={cn("absolute w-[256px] text-ink", MENU_SHEET, teamMotion.className)} {...teamMotion.exitProps}
          onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
            if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeTeamMenu(); return; }
            navigateThreadMenu(event);
          }}>
          <TeamMenuItems
            department={teamMotion.value!.name} onRead={closeTeamMenu} onAddBots={() => { closeTeamMenu(); setMoveToTeam(teamMotion.value!.name); }}
            onRename={() => { closeTeamMenu(); (advanced ? setRenameTeam : botDrag.startRename)(teamMotion.value!.name); }}
            onShare={() => { closeTeamMenu(); setShareTeam(teamMotion.value!.name); }}
            onDelete={() => { closeTeamMenu(); setDeletingTeam(teamMotion.value!.name); }}
            onSetForAll={teamSettingsAllowed === true ? () => { closeTeamMenu(); setTeamSettings(teamMotion.value!.name); } : undefined}
            onSetOwner={teamPeople?.admin ? () => { closeTeamMenu(); pickOwnerOf(state.bots.filter((bot) => !bot.hidden && (bot.section?.trim() || "") === teamMotion.value!.name), teamPeople, teamMotion.value!); } : undefined} onSeeReports={teamPeople ? () => { closeTeamMenu(); showWhoReportsToWhom(dispatch); } : undefined}
          />
        </div>
      </div>, document.body)}
      <ConfirmDialog open={deletingTeam !== null} title={t("team.deleteTitle", { name: deletingTeam ?? "" })}
        body={t(advanced ? "team.deleteKeepBotsDescription" : "team.deleteKeepBotsSimple")} confirmLabel={t("team.delete")} returnFocusRef={sidebarRef}
        pending={teamDeletePending}
        onCancel={() => { if (!teamDeleteRunning.current) setDeletingTeam(null); }} onConfirm={() => {
          const name = deletingTeam;
          if (!name || teamDeleteRunning.current) return;
          teamDeleteRunning.current = true;
          setTeamDeletePending(true);
          void api(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(({ sections }) => { dispatch({ type: "sectionDeleted", section: name, sections }); setDeletingTeam(null); })
            .catch(cause => setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) }))
            .finally(() => { teamDeleteRunning.current = false; setTeamDeletePending(false); });
        }} />
      {moveToTeam && <TeamDialog section={moveToTeam} onClose={() => setMoveToTeam(null)} />}
      {shareTeam !== null && <ShareTeamDialog team={shareTeam} onClose={() => setShareTeam(null)} />}
      {teamSettings !== null && <TeamSettingsDialog team={teamSettings} onClose={() => setTeamSettings(null)} />}
      <SectionPicker
          current={sectionPicker ? state.bots.find((b) => b.id === sectionPicker.botId)?.section : undefined}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => { if (sectionPicker) moveBotsToSection(dispatch, [sectionPicker.botId], section); }}
        />
      <RoomContextMenu
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => {
            if (!roomMenu) return;
            setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y });
          }}
          onDelete={(groupId) => {
            sidebarRef.current?.focus();
            setDeletingRoomId(groupId);
          }}
        />
      <ConfirmDialog
        open={deletingRoom !== undefined}
        {...roomDeleteCopy(deletingRoom ?? { name: "" })}
        icon={<Trash2 size={18} />}
        returnFocusRef={sidebarRef}
        onCancel={() => setDeletingRoomId(null)}
        onConfirm={() => {
          // Read the room from live state: it may have been removed while the dialog was open.
          const groupId = deletingRoom?.id;
          setDeletingRoomId(null);
          if (groupId) dispatch({ type: "deleteGroup", groupId });
        }}
      />
      <SectionPicker
          current={roomSectionPicker ? state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section : undefined}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) => {
            if (!roomSectionPicker) return;
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } });
          }}
        />
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {/* Portaled: below md the sidebar's translate makes it the containing block for fixed children. */}
      {newChatOpen && createPortal(
        <SidebarNewChatPanel
          anchor={sidebarRef.current}
          style={windowNoDragStyle}
          onClose={() => setNewChatOpen(false)}
          onNewBot={teamSettingsAllowed === false ? undefined : () => { setNewChatOpen(false); dispatch({ type: "newBot" }); }}
          onNewGroup={() => { setNewChatOpen(false); setNewRoom(true); }}
        />,
        document.body,
      )}
      {!remoteClient && archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {!remoteClient && teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback({
              error: false,
              text:
                (result.members === 0 && result.presets
                  ? t("sidebar.presetsImported", { count: result.presets })
                  : result.members === 1
                  ? t("sidebar.teamImportedOne")
                  : t("sidebar.teamImportedMany", { count: result.members })) +
                (result.connections ? ` · ${t("sidebar.connectionsToFinish", { count: result.connections })}` : ""),
            });
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  {t("common.undo")}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}

import { memo, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { ChevronRight, Crown, FolderPlus, Loader2, MoreHorizontal, Phone, Pin, Plus } from "lucide-react";
import { api, formatTime, visibleMessages, currentTaskBot, botOpensTo, type Action, type AppState, type Bot, type BotProject, type InstanceInfo, type Message } from "@/state/store";
import { approvalModeFor } from "../../shared/approval-mode";
import { liveActivityLabel, sidebarMessage } from "@/lib/live-activity";
import { SidebarWorkingStep } from "./SidebarWorkingStep";
import { openBotRow } from "@/state/thread-navigation";
import { llmThreadTitlesEnabled } from "@/lib/feature-flags";
import { BotAvatar } from "./Avatar";
import { BotEngineMark, BotModelBadge, botTooltip } from "./BotModelBadge";
import { SidebarBotRole } from "./BotRole";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { searchMatchesThreads, useSearchDisclosure } from "@/lib/search-disclosure";
import { lastNonReceipt } from "@/lib/receipts";
import { botPreview } from "./sidebar-preview";
import { activeLocale, t } from "@/lib/i18n";
import { BulkSelectFilters, ThreadListFooter, deleteThreadsInBulk, useBulkSelect } from "./BulkSelectBar";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { RenameTitle } from "./RenameTitle";
import { BotProjectDialog, FolderActions, FolderIcon } from "./BotProjects";
import { draggedFolder, FOLDER_DRAG_TYPE, moveFolder, placeFolder } from "@/lib/folder-order";
import { folderUnreadThreadIds, markFolderRead } from "@/lib/folder-read";
import { HelperThreadGroup, orderedThreadList, partitionHelperThreads, SidebarThreadRow, stampClock, threadRecency, threadRowActions, useRelativeNow, useRevealedThreadRow, useSnoozeExpiry, visibleSidebarThreads } from "./SidebarThreadRow";
import { useSidebarShowAllThreads, type SidebarDensity } from "@/lib/sidebar-preferences";
import { stepKey, type BotDropPlace } from "@/lib/sidebar-bot-drop";
import { BotDropLine, botRowDropClass, type BotRowDrag } from "./SidebarBotDrag";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";
import { useShowThreads } from "@/lib/thread-preferences";
import { useBotUnread } from "./unread-notice";
import { runningRoutineRun, SidebarBotActivity, sidebarBotStatus } from "./SidebarBotActivity";
import { AvatarActivityDot, RowDot, RowStatusText, rowSurface } from "./SidebarRowMarkers";
import { useLiveMedia } from "@/lib/live-call-media";
import { liveBadgeFor } from "./LiveCallPill";
import { useAdvancedMode } from "@/lib/interface-mode";

export interface MenuState {
  botId: string;
  x: number;
  y: number;
}

export function openBotContextMenu(onMenu: (menu: MenuState) => void, botId: string, event: React.MouseEvent) {
  event.preventDefault();
  onMenu({ botId, x: event.clientX, y: event.clientY });
}

const NO_FOLDERS: BotProject[] = [];

export function BotThreadList({ bot, selected, drafting, query, pendingQueued, routineRuns, reveal, locale, generatedTitles, dispatch, activityLabel, hidden = false }: BotRowProps & {
  activityLabel?: string;
  hidden?: boolean;
}) {
  const now = useRelativeNow();
  const tasks = (bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }])
    .filter((task) => !task.routineRunId)
    .map((task) => ({ ...task, queued: Boolean(pendingQueued[task.threadId]?.length) }));
  const projects = bot.projects ?? NO_FOLDERS;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ projectId: string; left: number; top: number } | null>(null);
  const [markingRead, setMarkingRead] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readStatus, setReadStatus] = useState("");
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [reorderStatus, setReorderStatus] = useState("");
  const [folderDrop, setFolderDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const draggingFolder = useRef<string | null>(null);
  const [showAll, setShowAll] = useSidebarShowAllThreads(bot.id);
  const [permissionRefresh, setPermissionRefresh] = useState<{ threadId: string; kind: "local-auto" } | null>(null);
  const currentProjectId = tasks.find((task) => task.threadId === bot.threadId)?.projectId;
  useEffect(() => {
    if (selected && currentProjectId) setCollapsed((previous) => {
      if (!previous.has(currentProjectId)) return previous;
      const next = new Set(previous);
      next.delete(currentProjectId);
      return next;
    });
  }, [selected, currentProjectId]);
  useSnoozeExpiry(tasks);
  const bulk = useBulkSelect();
  const { own: ownTasks, helpers } = bulk.active ? { own: tasks, helpers: [] } : partitionHelperThreads(tasks, bot.threadId, query, projects);
  const visibleTasks = orderedThreadList(visibleSidebarThreads(ownTasks, bot.threadId, query, projects, showAll || bulk.active, routineRuns));
  const visibleProjectIndex = (projectId: string) => visibleTasks.findIndex((task) => task.projectId === projectId);
  const folderRank = (projectId: string) => {
    const index = visibleProjectIndex(projectId);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const orderedProjects = query ? projects : [...projects].sort((a, b) => folderRank(a.id) - folderRank(b.id) || projects.indexOf(a) - projects.indexOf(b));
  useRevealedThreadRow(reveal, selected ? bot.threadId : null);
  const latest = useRef(bot);
  latest.current = bot;
  const botId = bot.id;
  const actions = useMemo(() => ({
    onSelect: (task: { threadId: string }) => {
      if (task.threadId !== latest.current.threadId) dispatch({ type: "switchTask", botId, threadId: task.threadId });
      else dispatch({ type: "select", id: botId });
    },
    ...threadRowActions(botId, dispatch, generatedTitles),
    onRefreshPermissions: (task: { threadId: string }) => {
      const current = latest.current;
      const mode = approvalModeFor(current);
      const threadMode = approvalModeFor(currentTaskBot(current, task.threadId));
      if (mode === "auto" && current.computer === "local" && threadMode !== "auto") {
        setPermissionRefresh({ threadId: task.threadId, kind: "local-auto" });
        return;
      }
      dispatch({ type: "refreshTaskPermissions", botId, threadId: task.threadId });
    },
  }), [botId, dispatch, generatedTitles]);
  const renderThread = (task: (typeof tasks)[number]) => {
    const thread = currentTaskBot(bot, task.threadId);
    return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: thread.busy, activity: thread.activity, waitingForTeammates: thread.waitingForTeammates }} ownerId={bot.id} current={selected && !drafting && task.threadId === bot.threadId} folders={projects}
      activityLabel={task.threadId === bot.threadId ? activityLabel : undefined} now={stampClock(threadRecency(task), now)} locale={locale} {...actions}
      selectMode={bulk.active} checked={selection.has(task.threadId)} onToggleSelect={bulk.toggle} />;
  };
  const ungrouped = visibleTasks.filter((task) => !projects.some((project) => project.id === task.projectId));
  const shownRows = [...orderedProjects.filter((project) => query || bulk.active || !collapsed.has(project.id)).flatMap((project) => visibleTasks.filter((task) => task.projectId === project.id)), ...ungrouped]
    .map((task) => { const thread = currentTaskBot(bot, task.threadId); return { ...task, busy: thread.busy, activity: thread.activity }; });
  const selection = bulk.forRows(shownRows);
  const projectToEdit = projects.find((project) => project.id === editingProject);
  const projectIds = projects.map((project) => project.id);
  const saveOrder = (ids: string[], onSaved?: () => void) => {
    if (reordering || ids.every((id, index) => id === projectIds[index])) return;
    setReordering(true); setReorderError(null); setReorderStatus(t("folder.reordering"));
    dispatch({ type: "reorderProjects", botId: bot.id, projectIds: ids,
      onSaved: () => { setReordering(false); setReorderStatus(t("folder.reordered")); onSaved?.(); },
      onError: (message) => { setReordering(false); setReorderStatus(""); setReorderError(message); } });
  };
  const resetFolderDrag = () => { draggingFolder.current = null; setFolderDrop(null); };
  const readFolder = async (projectId: string, onSaved: () => void) => {
    if (markingRead) return;
    setMarkingRead(true); setReadError(null); setReadStatus(t("folder.markingRead"));
    try {
      await markFolderRead(bot, projectId, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
      setReadStatus(t("folder.markedRead"));
      onSaved();
    } catch (error) {
      setReadError(error instanceof Error ? error.message : String(error));
      setReadStatus("");
    } finally { setMarkingRead(false); }
  };
  return (
    <div hidden={hidden} className="mb-2 space-y-0.5" role="group" aria-label={t("task.namedList", { name: bot.name })}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) event.stopPropagation(); }}
      onDrop={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) { event.preventDefault(); event.stopPropagation(); resetFolderDrag(); } }}>
      {!hidden && <>
      {bulk.active && <BulkSelectFilters rows={shownRows} selected={selection} now={now} onChange={bulk.setSelected} onDone={bulk.finish} />}
      {orderedProjects.map((project) => {
        const index = projects.indexOf(project);
        const projectTasks = tasks.filter((task) => task.projectId === project.id);
        const visible = visibleTasks.filter((task) => task.projectId === project.id);
        if (query && visible.length === 0 && !project.name.toLowerCase().includes(query.toLowerCase())) return null;
        const open = Boolean(query) || bulk.active || !collapsed.has(project.id);
        const waiting = projectTasks.some((task) => task.activity === "waiting-on-you");
        const working = projectTasks.some((task) => task.busy);
        return <div key={project.id} data-sidebar-project={project.id}>
          <div data-sidebar-folder-row={project.id} draggable={!reordering}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFolderMenu({ projectId: project.id, left: event.clientX, top: event.clientY }); }}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ botId: bot.id, projectId: project.id }));
              draggingFolder.current = project.id;
            }}
            onDragEnd={(event) => { event.stopPropagation(); resetFolderDrag(); }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.stopPropagation();
              if (!draggingFolder.current || reordering) { event.dataTransfer.dropEffect = "none"; return; }
              event.preventDefault(); event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setFolderDrop({ id: project.id, place: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
            }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFolderDrop(null); }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.preventDefault(); event.stopPropagation();
              const from = draggedFolder(event.dataTransfer.getData(FOLDER_DRAG_TYPE), bot.id, projectIds);
              const rect = event.currentTarget.getBoundingClientRect();
              if (from) saveOrder(placeFolder(projectIds, from, project.id, event.clientY < rect.top + rect.height / 2 ? "before" : "after"));
              resetFolderDrag();
            }}
            className={cn("group/folder flex items-center gap-0.5 rounded-md pl-0.5 text-ink-secondary hover:bg-raised/30",
              folderDrop?.id === project.id && draggingFolder.current !== project.id && (folderDrop.place === "before" ? "shadow-[0_-2px_var(--color-accent)]" : "shadow-[0_2px_var(--color-accent)]"))}>
            <button type="button" aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex size-6 shrink-0 items-center justify-center rounded outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60" aria-label={t(open ? "task.collapseNamed" : "task.expandNamed", { name: project.name })}>
              <ChevronRight aria-hidden="true" size={11} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            </button>
            <button type="button" aria-label={t("folder.iconNamed", { name: project.name })} title={t("folder.iconNamed", { name: project.name })} onClick={() => setEditingProject(project.id)} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-raised"><FolderIcon emoji={project.emoji} size={14} /></button>
            <button type="button" data-sidebar-folder-label={project.id} draggable={!reordering} aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex min-h-8 min-w-0 flex-1 cursor-grab select-none items-center gap-1.5 py-1 text-left text-[13px] font-semibold active:cursor-grabbing" title={project.name}>
              <span className="truncate">{project.name}</span>
              <span className="shrink-0 text-[10px] font-normal opacity-50">{projectTasks.length}</span>
              {!open && (waiting ? <span className="text-[10px] text-warning">{t("task.waiting")}</span> : working ? <Loader2 size={10} className="shrink-0 animate-spin text-success" /> : projectTasks.some((task) => task.unread) ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} /> : null)}
            </button>
            <button type="button" title={t("task.newIn", { name: project.name })} aria-label={t("task.newIn", { name: project.name })} onClick={() => dispatch({ type: "newTask", botId: bot.id, projectId: project.id })}
              className="flex size-6 items-center justify-center rounded opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/folder:opacity-100 max-md:opacity-70 touch:opacity-70"><Plus size={12} /></button>
            <FolderActions project={project} canMoveUp={index > 0} canMoveDown={index < projects.length - 1} canMarkRead={folderUnreadThreadIds(bot, project.id).length > 0} saving={reordering || markingRead}
              menu={folderMenu?.projectId === project.id ? folderMenu : null} onMenuChange={(menu) => setFolderMenu(menu ? { ...menu, projectId: project.id } : null)}
              onEdit={() => setEditingProject(project.id)} onMove={(direction, onSaved) => saveOrder(moveFolder(projectIds, project.id, direction), onSaved)}
              onMarkRead={(onSaved) => { void readFolder(project.id, onSaved); }} />
          </div>
          {(open || visible.some((task) => task.pinned === true)) && <div role="group" aria-label={t("task.namedList", { name: project.name })}>
            {(open ? visible : visible.filter((task) => task.pinned === true)).map(renderThread)}
            {projectTasks.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-tertiary">{t("task.empty")}</p>}
            {/* A closed folder shows only its pinned threads. The short list keeps only the newest threads, so an open folder can hold none of them: offer the rest. */}
            {open && !query && !bulk.active && visible.length < projectTasks.length && <button type="button" data-sidebar-folder-show-all={project.id} onClick={() => setShowAll(true)}
              className="inline-flex h-7 items-center pl-6 text-[13px] font-medium leading-4 text-ink-secondary hover:text-ink">{t("folder.showAll")}</button>}
          </div>}
        </div>;
      })}
      {reorderError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{reorderError}</p>}
      <span role="status" className="sr-only">{reorderStatus}</span>
      {readError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{readError}</p>}
      <span role="status" className="sr-only">{readStatus}</span>
      {projects.length > 0 && ungrouped.length > 0 && <div className="pl-6 pr-3 pb-1 pt-2 text-[11px] text-ink-tertiary">{t("task.list")}</div>}
      {ungrouped.map(renderThread)}
      <HelperThreadGroup tasks={orderedThreadList(helpers)} renderThread={renderThread} />
      <ThreadListFooter bulk={bulk} rows={shownRows} selected={selection} total={ownTasks.length} canShowAll={!query && !showAll && ownTasks.length > visibleTasks.length} canSelect={tasks.length > 1}
        onShowAll={() => setShowAll(true)} onShowFewer={showAll && !query && !bulk.active && visibleSidebarThreads(ownTasks, bot.threadId, query, projects, false, routineRuns).length < ownTasks.length ? () => setShowAll(false) : undefined} freshConversation onDelete={(threadIds) => deleteThreadsInBulk({ botId: bot.id }, threadIds, dispatch)} />
      <LocalComputerAutoWarning
        open={permissionRefresh?.kind === "local-auto"}
        onCancel={() => setPermissionRefresh(null)}
        onConfirm={() => {
          const threadId = permissionRefresh?.threadId;
          setPermissionRefresh(null);
          if (threadId) dispatch({ type: "refreshTaskPermissions", botId: bot.id, threadId, acknowledgeLocalAuto: true });
        }}
      />
      {projectToEdit && <BotProjectDialog bot={bot} project={projectToEdit} onClose={() => setEditingProject(null)} />}
      </>}
    </div>
  );
}

export interface BotRowProps {
  bot: Bot;
  selected: boolean;
  drafting?: boolean;
  deleting: boolean;
  mascotMotion: AppState["mascotMotion"];
  reveal: AppState["revealThread"];
  pendingQueued: AppState["pendingQueued"];
  routineRuns?: AppState["routineRuns"];
  instances: InstanceInfo[];
  liveCall: AppState["liveCall"];
  locale: string;
  generatedTitles: boolean;
  density: SidebarDensity;
  query: string;
  dispatch: Dispatch<Action>;
  onMenu: (menu: MenuState) => void;
  renameRequest?: number;
  botDrag?: BotRowDrag;
  botDrop?: BotDropPlace | null;
  botDragging?: boolean;
}

export function botRowProps(
  state: AppState,
  dispatch: Dispatch<Action>,
  bot: Bot,
  layout: Pick<BotRowProps, "density" | "query" | "onMenu" | "renameRequest" | "botDrag" | "botDrop" | "botDragging">,
): BotRowProps {
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const drafting = state.newChat?.botId === bot.id;
  const reveal = state.revealThread;
  return {
    ...layout,
    bot,
    selected,
    drafting,
    deleting: state.deletingBots[bot.id] === true,
    mascotMotion: selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null,
    reveal: reveal && (bot.threadId === reveal.threadId || bot.tasks?.some((task) => task.threadId === reveal.threadId)) ? reveal : null,
    pendingQueued: state.pendingQueued,
    routineRuns: state.routineRuns,
    instances: state.instances,
    liveCall: state.liveCall,
    locale: activeLocale(),
    generatedTitles: llmThreadTitlesEnabled(state.config),
    dispatch,
  };
}

export function useVisibleMessages(bot: Bot): Message[] {
  const { messages, activeLeafId } = bot;
  return useMemo(() => visibleMessages({ messages, activeLeafId }), [messages, activeLeafId]);
}

export const BotListItem = memo(function BotListItem(props: BotRowProps) {
  const advanced = useAdvancedMode();
  const { bot, selected, deleting, mascotMotion, reveal, pendingQueued, instances, liveCall, density, query, dispatch, onMenu, renameRequest, botDrag: drag, botDrop: drop, botDragging: dragging } = props;
  const showThreads = useShowThreads();
  const liveMedia = useLiveMedia();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`bot:${bot.id}`, showThreads ? query : "", searchMatchesThreads(query, bot.tasks, bot.projects));
  useEffect(() => { if (reveal && showThreads) setThreadsOpen(true); }, [reveal, showThreads]);
  const hasThreadList = (bot.tasks?.filter((task) => !task.routineRunId).length ?? 1) > 1 || (bot.projects?.length ?? 0) > 0 || Boolean(query);
  const iconOnly = density === "icons";
  const expanded = showThreads && !iconOnly && threadsOpen && hasThreadList;
  useEffect(() => { if (iconOnly) setRenaming(false); }, [iconOnly]);
  const simpleRow = !advanced && !showThreads && density === "comfortable";
  const simpleList = !advanced && !iconOnly;
  const railTile = iconOnly && !advanced;
  const avatarSize = iconOnly ? (railTile ? 36 : 44) : showThreads ? 32 : simpleRow ? 36 : 44;
  const tooltip = simpleList ? botTooltip(bot, instances) : undefined;
  const visible = useVisibleMessages(bot);
  const last = lastNonReceipt(visible);
  const title = bot.title.trim();
  const details = [title, bot.chiefOfStaff ? t("sidebar.bot.chiefOfStaff") : ""].filter(Boolean);
  const rowClass = cn(
    "flex w-full items-center rounded-xl text-left transition-colors duration-150", SIMPLE_ROW_FOCUS,
    iconOnly
      ? railTile ? "h-[54px] justify-center" : "justify-center px-1 py-1.5"
      : simpleRow ? "gap-2 rounded-[8px] py-2 pl-2 pr-2 md:h-[54px] md:py-0"
        : cn(showThreads ? "gap-2 py-2" : "gap-3 py-2", showThreads ? "pl-6 pr-9 group-hover:pr-[5.75rem] group-focus-within:pr-[5.75rem] max-md:pr-9 touch:pr-[5.75rem]" : "pl-2.5 pr-9"),
    !iconOnly && "max-md:rounded-2xl max-md:py-2.5",
    selected ? "bg-raised" : "hover:bg-raised/50",
    simpleRow && rowSurface(selected),
  );
  const { waiting, working, teammateWait, queued } = sidebarBotStatus(bot, pendingQueued);
  const { unread, noticing } = useBotUnread(bot);
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  const body = (
    <>
      <span className={cn("relative flex shrink-0", simpleRow && "-m-[3px]")} title={iconOnly || simpleList ? undefined : [bot.name, ...details].join(" · ")}>
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={simpleRow ? avatarSize + 6 : avatarSize}
          fallback="preset"
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || noticing || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {/* Bottom-left, clear of the status dots on the right and of the row's hover actions. */}
        {(iconOnly || !simpleList) && <BotModelBadge bot={bot} instances={instances} avatarSize={avatarSize} />}
        {simpleRow && <AvatarActivityDot activity={working ? "working" : teammateWait ? "teammate" : queued && !waiting ? "queued" : null} />}
        {!simpleRow && working && (
          <span
            data-testid="working-dot"
            className={cn(
              "absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-success",
              iconOnly ? "size-3" : "size-2.5",
            )}
          />
        )}
        {!simpleRow && waiting && <span data-testid="waiting-dot" role="status" aria-label={t("sidebar.preview.waiting")} title={t("sidebar.preview.waiting")}
          className={cn("absolute -right-0.5 -bottom-0.5 flex items-center justify-center overflow-hidden rounded-full border-2 border-panel bg-warning font-black text-panel", iconOnly ? "size-5 text-[14px]" : "size-4 text-[12px]")}><span aria-hidden="true">!</span></span>}
        {!simpleRow && teammateWait && <span data-testid="teammate-wait-dot" role="status" aria-label={t("sidebar.preview.waitingOnTeammate")} title={t("sidebar.preview.waitingOnTeammate")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-accent", iconOnly ? "size-3" : "size-2.5")} />}
        {!simpleRow && !teammateWait && !waiting && !working && queued && <span data-testid="queued-dot" role="status" aria-label={t("task.queued")} title={t("task.queued")}
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-panel bg-ink-secondary", iconOnly ? "size-3" : "size-2.5")} />}
        {bot.chiefOfStaff && (iconOnly || simpleRow) && (
          <span className="absolute -left-1 -top-1 flex rounded-full bg-raised p-[3px]">
            <Crown size={11} strokeWidth={2.25} className="shrink-0 text-accent" role="img" aria-label={t("sidebar.bot.chiefOfStaff")} data-testid="chief-crown">
              <title>{t("sidebar.bot.chiefOfStaff")}</title>
            </Crown>
          </span>
        )}
        {onLiveCall && iconOnly && (
          <span className="absolute -right-1 -top-1 flex rounded-full bg-panel p-0.5">
            <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
              <title>{t("call.live.badge")}</title>
            </Phone>
          </span>
        )}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className={cn("flex items-baseline justify-between gap-2", simpleRow && "pr-7")}>
          <span className={cn("flex min-w-0 grow items-center gap-1.5 truncate text-ink", simpleRow ? "text-[14px] font-medium leading-5" : "text-[15px] font-semibold leading-5")}>
            {!simpleList && bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              editRequest={renameRequest}
              title={tooltip}
              onCommit={(name) => {
                if (remoteClient) {
                  void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                    .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                    .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
                } else {
                  dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
                }
              }}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName={cn("w-full rounded bg-inset px-1 py-0.5", simpleRow ? "text-[14px] font-medium" : "text-[15px] font-semibold")}
            />
            {!simpleList && bot.chiefOfStaff && !renaming && (
              <Crown size={13} strokeWidth={2.25} className="shrink-0 text-accent" role="img" aria-label={t("sidebar.bot.chiefOfStaff")} data-testid="chief-crown">
                <title>{t("sidebar.bot.chiefOfStaff")}</title>
              </Crown>
            )}
            {onLiveCall && !iconOnly && !renaming && (
              <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
                <title>{t("call.live.badge")}</title>
              </Phone>
            )}
            {!simpleList && title && !renaming && <SidebarBotRole role={title} />}
          </span>
          {last && !renaming && !expanded && (
            <span className={cn(
              "shrink-0 text-[12px] tabular-nums text-ink-secondary transition-opacity",
              // Phones show the time on every row; elsewhere only the selected row, until its actions appear.
              selected && !simpleList ? "group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0 max-md:touch:opacity-100" : "hidden max-md:inline",
            )}>
              {formatTime(last.at)}
            </span>
          )}
          {expanded && unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
          {simpleRow && (unread || waiting) && <RowDot waiting={waiting} />}
        </div>
        {(!expanded || deleting) && <div className="flex items-center justify-between gap-2">
          {deleting ? (
            <span role="status" className="flex min-w-0 items-center gap-1.5 truncate text-[13px] leading-[18px] text-ink-secondary">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              {t("sidebar.bot.deletingRow")}
            </span>
          ) : (
            <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-[13px] leading-[18px]", waiting ? simpleRow ? "text-warning" : "font-semibold text-warning" : "text-ink-secondary")}>
              {working ? (
                <SidebarWorkingStep bot={bot} last={last} />
              ) : (
                <span dir="auto" className="truncate">{waiting ? t("sidebar.preview.waiting") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : botPreview(bot, visible, instances, advanced)}</span>
              )}
            </span>
          )}
          {simpleRow && <BotEngineMark bot={bot} instances={instances} className="ms-auto" />}
          {!simpleRow && unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>}
        {simpleRow && <RowStatusText working={working} unread={unread} />}
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    openBotContextMenu(onMenu, bot.id, event);
  };
  const onSelect = (event: React.MouseEvent) => {
    if (renaming) return;
    const insideRenameInput = event.target instanceof HTMLInputElement;
    if (botListItemPointerIntent(event.type, insideRenameInput) === "select") {
      openBotRow(dispatch, bot, showThreads, selected);
    }
  };

  return (
    <>
    <div className={cn("group relative", railTile && "mx-auto w-[54px]", botRowDropClass(drop, dragging))} data-bot-drop={drop ?? undefined} {...(drag && !renaming ? drag.row(bot.id) : {})}
      title={railTile ? botTooltip(bot, instances) : iconOnly ? [bot.name, bot.title?.trim()].filter(Boolean).join(" · ") : undefined}><BotDropLine place={drop} />
      {/* Keep this wrapper mounted: replacing it remounts RenameTitle and leaves the row stuck in rename mode. */}
      <div
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={
          !renaming && iconOnly
            ? deleting
              ? t("sidebar.bot.deletingAria", { name: bot.name })
              : `${bot.name}${bot.title?.trim() ? ` · ${bot.title.trim()}` : ""}${bot.chiefOfStaff ? ` · ${t("sidebar.bot.chiefOfStaff")}` : ""}${onLiveCall ? ` · ${t("call.live.badge")}` : ""}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : teammateWait ? ` · ${t("sidebar.preview.waitingOnTeammate")}` : queued ? ` · ${t("task.queued")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`
            : undefined
        }
        aria-busy={deleting || undefined} aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-current={selected && !expanded && !renaming ? "page" : undefined}
        data-sidebar-bot-row={bot.id}
        title={renaming ? undefined : tooltip}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (renaming) return;
          if (drag && stepKey(event)) { event.preventDefault(); drag.step(bot.id, stepKey(event)!); return; }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openBotRow(dispatch, bot, showThreads, selected);
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {showThreads && !iconOnly && hasThreadList && <button
        type="button"
        aria-label={t(threadsOpen ? "task.collapseNamed" : "task.expandNamed", { name: bot.name })}
        aria-expanded={threadsOpen}
        onClick={() => setThreadsOpen((open) => !open)}
        className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60"
      ><ChevronRight aria-hidden="true" size={13} className={cn("transition-transform", threadsOpen && "rotate-90")} /></button>}
      {!renaming && iconOnly && unread && (
        <span className={cn("pointer-events-none absolute size-2 rounded-full border border-panel bg-accent", railTile ? "right-1 top-1" : "bottom-1.5 right-1.5")} />
      )}
      {!renaming && !deleting && !iconOnly && <>
        {showThreads && <button type="button" aria-label={t("task.newShort")} title={t("task.newShort")} onClick={() => { setThreadsOpen(true); dispatch({ type: "newTask", botId: bot.id }); }}
          className="pointer-events-none absolute right-[3.75rem] top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:hidden touch:pointer-events-auto touch:opacity-70"><Plus size={14} /></button>}
        {showThreads && <button type="button" aria-label={t("folder.newNamed", { name: bot.name })} title={t("folder.new")} onClick={() => { setThreadsOpen(true); setCreatingProject(true); }}
          className="pointer-events-none absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:hidden touch:pointer-events-auto touch:opacity-70"><FolderPlus size={14} /></button>}
        <button type="button" data-bot-actions={bot.id} aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
          className={cn("absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink", simpleRow && "right-2 top-1 translate-y-0 rounded-lg",
            selected && !simpleRow ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70")}><MoreHorizontal size={15} /></button>
      </>}
      {deleting && iconOnly && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-card p-1 text-ink-secondary">
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
    </div>
    {advanced && !iconOnly && threadsOpen && hasThreadList && <BotThreadList {...props} hidden={!showThreads}
      activityLabel={liveActivityLabel(sidebarMessage(last))}
      query={bot.name.toLowerCase().includes(query.toLowerCase()) || bot.title.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    {(advanced || (!iconOnly && (waiting || unread || bot.tasks?.some(runningRoutineRun)))) && <SidebarBotActivity bot={bot} rowThreadId={selected ? bot.threadId : botOpensTo(bot, showThreads)} density={density} pendingQueued={pendingQueued} dispatch={dispatch} waitingOnly={!advanced} runsOnly={expanded} />}
    {showThreads && creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
    </>
  );
});

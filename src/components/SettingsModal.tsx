import { useEffect, useRef, useState } from "react";
import { Search, User, X } from "lucide-react";
import { useStore, type AppSettingsSection } from "@/state/store";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { AdminOnly } from "./AdminOnly";
import { KeysPage } from "./keys/KeysPage";
import { KEY_CATALOG, keyMatches, keySection, type KeyEntry } from "./keys/key-catalog";
import { openKeySettings, useKeyFocus } from "./keys/key-focus";
import { AnalyticsRow } from "./AnalyticsRow";
import { UpdatesConsentRow } from "./UpdatesConsent";
import { OpenAtLoginRow } from "./OpenAtLoginRow";
import { DefaultBotSidebarRow } from "./DefaultBotControls";
import { TalkShortcutRow } from "./TalkShortcutRow";
import { AttachmentStorageSettings } from "./AttachmentStorageSettings";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { ImageGenerationSettings } from "./ImageGenerationSettings";
import { VideoGenerationSettings } from "./VideoGenerationSettings";
import { EngineMaintenance } from "./EnginesSettings";
import { ModelManagement } from "./ModelManagement";
import { LocalComputerSection } from "./LocalComputerSection";
import { PhoneDevicesSection } from "./PhoneDevicesSection";
import { pageIsThisComputer } from "@/lib/companion-bridge";
import { ServerPairingCard } from "./ServerPairingCard";
import { PeopleSection } from "./PeopleSection";
import { ActivitySection } from "./ActivitySection";
import { AccessOverview } from "./bot-access/AccessOverview";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { currentPhonePairingTarget, phonePairingSettingsAction } from "@/lib/phone-pairing";
import { CustomDomainSettings } from "./CustomDomainSettings";
import { BuiltInBrowserRow, ServerSitesRow } from "./BrowserSettingsRows";
import { VaultSettings } from "./VaultSettings";
import { PaymentCardsSettings } from "./PaymentCardsSettings";
import { ChannelsSettings } from "./ChannelsSettings";
import { RemoteComputerSection } from "./RemoteComputerSection";
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";
import { PlaceLookCard } from "./PlaceLookCard";

import { OrganizationSettings } from "./OrganizationSettings";
import { CloudAccountSettings } from "./CloudAccountSettings";
import { MarketSubscriptionCard } from "./MarketSubscriptionCard";
import { CloudUsageSettings } from "./CloudUsageMeter";
import { ProSettingsCard } from "./ProIntroduction";
import { Card, SettingsGroup as SettingsGroupBlock, SIMPLE_BUTTONS } from "./SettingsPrimitives";
import { Layer, useIsTopLayer } from "./Layer";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SkillsSection } from "./SkillsSection";
import { LicenseExpiryBanner } from "./LicenseExpiryBanner";
import { WorkspacesSection, workspacesAvailable } from "./WorkspacesSection";
import { SkinPicker } from "./SkinPicker";
import { ThemeRow } from "./ThemeRow";
import { AvatarStyleRow, ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "./AppearanceSelectRows";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { ProfileFields } from "./ProfileSettings";
import { AwayEmailsSetting } from "./AwayEmailsSetting";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { PinnedPanelsSettings } from "./PinnedPanelsSettings";
import { DefaultBotSettings } from "./NewBotDialog";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { ImportSettings } from "./ImportSettings";
import { cn } from "@/lib/cn";
import { scrollWithin } from "@/lib/scroll-within";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { NotificationRows } from "./NotificationSettingsRows";
import { useAdvancedMode } from "@/lib/interface-mode";
import { Select } from "./Select";
import { SavedStepsRow } from "./SavedStepsRow";
import { PhoneVerifyRow } from "./PhoneVerifyRow";
import { BrowserProfilesRow, ColorUserBubblesRow, AdvancedModeRow, ExperimentalFeaturesRow, LanguageRow, PinnedCirclesRow, ReplayTourRow, RunCardRow, FollowUpRow, SendKeyRow, ShowThreadsRow, ToolCallsRow, UniversalPinsRow, UpdatesRow } from "./AppSettingsRows";
import { SimpleAdvancedPage, SimpleAiPage, SimpleBillingPage, SimpleComputerPage, SimpleGeneralPage, SimpleTeamPage, SimpleUpdatesPage, type Disclose, type SimpleDisclosureId } from "./SettingsSimplePages";
import type { SettingsRowEntry } from "./settings/rows";

// The information architecture lives in settings/registry.ts, so a new page or row is one file's edit. It is re-exported
// here because every caller and test already reaches it through this module.
import {
  ADVANCED_PAGES, SETTINGS_GROUPS, SECTIONS, SIMPLE_FOLDED, SIMPLE_PAGES, advancedSettingsPages, pageOf,
  revealSettingsBlock, rowSearchResults, sectionMatches, simplePageMatches, simpleSettingsPages,
  type SettingsGroup as SettingsRailGroup, type SimpleSettingsPage,
} from "./settings/registry";
export {
  ADVANCED_PAGES, SETTINGS_GROUPS, SECTIONS, SIMPLE_FOLDED, SIMPLE_PAGES, advancedSettingsPages, pageOf,
  revealSettingsBlock, rowSearchResults, sectionMatches, simplePageMatches, simpleSettingsPages,
  type SimpleSettingsPage,
};
export type { SettingsRailGroup as SettingsGroup };

/** What a search result scrolls to: the row it names, or the section's block when that row is not drawn here. */
type SettingsReveal = { rows?: readonly string[]; block: string };

/** One line of the search list. The rail and the narrow-window panel both draw these, so the two cannot drift apart. */
type SettingsSearchResult = {
  /** Becomes `data-settings-<kind>`, which the tests and the DOM read a result by. */
  kind: "page" | "section" | "row" | "advanced" | "more" | "key";
  id: string;
  label: string;
  hint?: string;
  icon?: typeof User;
  current?: boolean;
  select: () => void;
};

const RESULT_ATTRIBUTE = { page: "page", section: "section", row: "row-result", advanced: "advanced-only", more: "more-result", key: "key-result" } as const;

/** The attribute value a row is found by, quoted for the selector: a title may hold a quote or a backslash. */
function rowSelector(titles: readonly string[]): string {
  return titles.map((title) => `[data-settings-row="${title.replace(/[\\"]/g, "\\$&")}"]`).join(", ");
}

function SearchResultButton({ result, className }: { result: SettingsSearchResult; className: string }) {
  const Icon = result.icon;
  return (
    <button
      type="button"
      {...{ [`data-settings-${RESULT_ATTRIBUTE[result.kind]}`]: result.id }}
      onClick={result.select}
      aria-current={result.current ? "page" : undefined}
      className={className}
    >
      {Icon && <Icon size={15} aria-hidden="true" className="shrink-0" />}
      <span className="truncate">{result.label}{result.hint && <span className="text-ink-secondary"> · {result.hint}</span>}</span>
    </button>
  );
}

function keySearchResults(query: string): KeyEntry[] {
  // The custom model provider moved to AI → Luna Bot models; its key row is no longer in API keys.
  return query ? KEY_CATALOG.filter((entry) => entry.id !== "openaiCompat" && keyMatches(entry, query)).slice(0, 8) : [];
}

const openKeyResult = (entry: KeyEntry) => entry.uses ? openKeySettings(entry.uses, entry.id) : openKeySettings(entry.id);

export function SettingsModal() {
  return <Layer modal><SettingsDialog /></Layer>;
}

function SettingsDialog() {
  const isTop = useIsTopLayer();
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const remoteActive = window.ogb?.remoteClient?.active === true;
  const requested = state.appSettingsSection;
  const section: AppSettingsSection =
    advanced && requested === "remote" && window.ogb?.environments
      ? "desktopWorkspaces"
      : (remoteActive && !["appearance", "desktopWorkspaces"].includes(requested)) || requested === "remote"
      ? "companion"
      : advanced && requested === "updates" ? "general" : requested;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchFirst = useRef(advanced);
  const [query, setQuery] = useState("");
  useEffect(() => window.ogb?.environments?.onOpenSettings?.(() => setQuery("")), []);
  useEffect(() => window.ogb?.onOpenAppSettings?.(() => setQuery("")), []);
  const q = query.trim().toLowerCase();
  const ownerOrAdmin = useOwnerOrAdmin();
  const thisComputer = pageIsThisComputer();
  const sectionsHere = SECTIONS.map((entry) => entry.id === "companion"
    ? { ...entry, labelKey: thisComputer ? "settings.section.phoneDevices" as const : "settings.section.thisServer" as const }
    : entry);
  const baseSections = sectionsHere.filter((entry) => !remoteActive || entry.id === "companion" || entry.id === "appearance" || entry.id === "desktopWorkspaces")
    .filter((entry) => entry.id !== "desktopWorkspaces" || Boolean(window.ogb?.environments))
    .filter((entry) => entry.id !== "organization" || Boolean(window.ogb?.organization))
    .filter((entry) => entry.id !== "cloudAccount" || Boolean(window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true)))
    .filter((entry) => entry.id !== "marketSubscription" || Boolean(window.ogb?.market))
    .filter((entry) => entry.id !== "workspaces" || workspacesAvailable(state.config))
    .filter((entry) => entry.id !== "people" || (!window.ogb && state.config?.cloudHome !== true))
    .filter((entry) => entry.id !== "activity" || (!window.ogb && ownerOrAdmin === true))
    .filter((entry) => entry.id !== "botAccess" || (Boolean(state.config?.team) && ownerOrAdmin === true));
  const availableSections = baseSections.filter((entry) => entry.id !== "skills" || skillsLibraryEnabled(state.config));
  const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));

  const availableSet = new Set<AppSettingsSection>(availableSections.map((entry) => entry.id));
  const simpleAvailable = new Set<AppSettingsSection>([...availableSet, ...(remoteActive ? [] : ["updates" as const])]);
  const simplePages = advanced ? [] : simpleSettingsPages(simpleAvailable);
  const advancedPages = advanced ? advancedSettingsPages(availableSet) : [];
  const activePages = advanced ? advancedPages : simplePages;
  const visiblePages = activePages.filter((page) => simplePageMatches(page, q));
  const currentPage = activePages.find((page) => page.sections.includes(section));

  const sectionLabelKey = currentPage?.labelKey;
  const nextVisibleSection = currentPage && visiblePages.includes(currentPage)
    ? undefined
    : visiblePages[0] && (visiblePages[0].sections.find((id) => visibleSections.some((entry) => entry.id === id)) ?? visiblePages[0].sections[0]);

  useEffect(() => {
    if (nextVisibleSection) dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });
  }, [dispatch, nextVisibleSection]);

  const [folds, setFolds] = useState<Partial<Record<SimpleDisclosureId, boolean>>>({});
  const keyFocus = useKeyFocus();
  useEffect(() => { if (keyFocus) setFolds((current) => current["ai-keys"] ? current : { ...current, "ai-keys": true }); }, [keyFocus]);
  const disclose: Disclose = (id) => {
    const open = q !== "" || (folds[id] ?? SIMPLE_FOLDED[requested] === id);
    return { id, open, onToggle: () => setFolds((current) => ({ ...current, [id]: !open })) };
  };
  const [reveal, setReveal] = useState<SettingsReveal | null>(null);
  const rowResults = advanced ? [] : rowSearchResults(q, simpleAvailable);
  const advancedRowResults = advanced ? rowSearchResults(q, availableSet) : [];
  const looksMatches = rowResults.filter((entry) => entry.simpleLooks);
  const moreMatches = rowResults.filter((entry) => entry.simpleMore);
  const pageRowMatches = rowResults.filter((entry) => !entry.simpleLooks && !entry.simpleMore);
  const keyResults = remoteActive || !availableSet.has("connections") ? [] : keySearchResults(q);
  /** Advanced uses Muse-style flat pages; this list drives both the rail and the narrow-window search panel. */
  const advancedResults: SettingsSearchResult[] = [
    ...visiblePages.map((page) => ({ kind: "page" as const, id: page.id, label: t(page.labelKey), icon: page.icon, current: page === currentPage,
      select: () => { setQuery(""); openSection(page.sections[0]!); } })),
    ...keyResults.map((entry) => ({ kind: "key" as const, id: entry.id, label: t(entry.labelKey), hint: t(keySection(entry).titleKey),
      select: () => { setQuery(""); dispatch(openKeyResult(entry)); } })),
    ...advancedRowResults.map((entry) => ({ kind: "row" as const, id: entry.titleKeys[0], label: t(entry.titleKeys[0]), hint: t(advancedPages.find((page) => page.sections.includes(entry.section))?.labelKey ?? SECTIONS.find((candidate) => candidate.id === entry.section)?.labelKey ?? "settings.title"),
      select: () => { setQuery(""); openSection(entry.section); setReveal({ rows: entry.titleKeys.map((key) => t(key)), block: entry.section }); } })),
  ];
  const keyResultButtons = (className: string) => keyResults.map((entry) => (
    <button key={entry.id} type="button" data-settings-key-result={entry.id} className={className}
      onClick={() => { setQuery(""); dispatch(openKeyResult(entry)); }}>
      <span>{t(entry.labelKey)} <span className="text-ink-secondary">· {t(keySection(entry).titleKey)}</span></span>
    </button>
  ));

  const sectionIndex = currentPage?.sections.indexOf(section) ?? 0;
  const revealBlock = !advanced && requested === "remote" ? "remote" : section;
  useEffect(() => {
    if (scrollRef.current) revealSettingsBlock(scrollRef.current, revealBlock as AppSettingsSection, revealBlock === section ? sectionIndex : 1);
  }, [revealBlock, section, sectionIndex]);
  useEffect(() => {
    if (!reveal) return;
    const scroller = scrollRef.current;
    const row = reveal.rows?.length ? scroller?.querySelector<HTMLElement>(rowSelector(reveal.rows)) : null;
    const block = scroller?.querySelector<HTMLElement>(`[data-settings-block="${reveal.block}"]`);
    const target = row ?? block;
    if (scroller && target) scrollWithin(scroller, target);
    setReveal(null);
  }, [reveal]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    // Two fields share this attribute: the rail's, and the header's where the rail is hidden. Only one is ever visible.
    const visibleSearch = () => [...dialog?.querySelectorAll<HTMLInputElement>("[data-settings-search]") ?? []]
      .find((input) => input.checkVisibility());
    if (searchFirst.current && visibleSearch()) visibleSearch()!.focus();
    else dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      const search = visibleSearch();
      if (!searchFirst.current && dialog && document.activeElement === dialog && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
        && search) {
        event.preventDefault();
        search.focus();
        setQuery((current) => current + event.key);
        return;
      }
      // A child editor owns Escape and its focus trap, including while saving.
      if (event.defaultPrevented || (dialog && [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .some(child => child.getClientRects().length))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.checkVisibility());
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch, isTop]);

  const openSection = (id: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section: id });

  const phoneFocus = state.appSettingsPhonePairing;
  const computerPairs = currentPhonePairingTarget(state.config?.cloudHome === true) === "computer";
  const remoteAccess = {
    client: <RemoteComputerSection hideWhenUnavailable legacyOnly />,
    domain: remoteActive || thisComputer ? null : <CustomDomainSettings />,
    // Security: the server decides who may pair (an owner or admin session), not this gate.
    pairing: thisComputer ? null : <ServerPairingCard cloudHome={state.config?.cloudHome === true} focusRequest={computerPairs ? 0 : phoneFocus} team={state.config?.team?.name} teamPhoneBlocked={state.config?.managedPolicy?.remoteAccess === false ? t("policy.teamRemoteBlocked", { organization: state.config.managedPolicy.organizationName }) : null} simple={!advanced} />,
    companion: thisComputer ? <PhoneDevicesSection profileEmail={state.config?.profile?.email} focusRequest={phoneFocus} simple={!advanced} /> : null,
  };

  const renderSection = (id: AppSettingsSection) => {
    switch (id) {
      case "desktopWorkspaces":
        return <><ConnectedWorkspacesSettings />{remoteAccess.client}</>;
      case "organization":
        return window.ogb?.organization && !remoteActive ? <OrganizationSettings /> : null;
      case "cloudAccount":
        return (window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true)) && !remoteActive
          ? <CloudAccountSettings linkRequest={state.appSettingsCloudLink} cloudHome={state.config?.cloudHome === true} teamHome={state.config?.team}
            onConnectPhone={() => dispatch(phonePairingSettingsAction())} onAddCloud={advanced ? () => dispatch({ type: "openCloudAdd", source: "app_settings" }) : undefined}
            onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
          : null;
      case "marketSubscription":
        return window.ogb?.market && !remoteActive ? <MarketSubscriptionCard /> : null;
      case "general":
        return (
          <>
            <AdvancedModeRow />

            <SettingsGroupBlock label={t("settings.group.account")} stack>
              <DefaultBotSidebarRow />
              <TalkShortcutRow />
              <ProSettingsCard />
              <Card title={t("settings.profile.title")} subtitle={t("settings.profile.sharedSubtitle")}>
                <ProfileFields />
                <AwayEmailsSetting />
              </Card>
            </SettingsGroupBlock>

            <SettingsGroupBlock label={t("settings.group.chat")} stack>
              <LanguageRow />
              <DefaultBotSettings />
            </SettingsGroupBlock>

            <SettingsGroupBlock label={t("settings.group.thisComputer")} stack>
              <OpenAtLoginRow />
              <AnalyticsRow />
              <UpdatesConsentRow />
              <PinnedPanelsSettings />
              <UpdatesRow />
              <DiagnosticsRow />
              {!remoteActive && <ReplayTourRow />}
            </SettingsGroupBlock>
          </>
        );
      case "appearance":
        return (
          <>
            <SettingsGroupBlock label={t("settings.section.appearance")} stack>
              <ThemeRow />
              <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
                <SkinPicker />
              </Card>
              <Card>
                <AvatarStyleRow />
              </Card>
              <PlaceLookCard />
              {remoteActive && <AdvancedModeRow />}
              {remoteActive && <LanguageRow />}
              <ColorUserBubblesRow />
              {!remoteActive && <ToolCallsRow />}
              <RunCardRow />
            </SettingsGroupBlock>

            <SettingsGroupBlock label={t("settings.group.chat")} stack>
              <FontRow />
              <ChatWidthRow />
              <SendKeyRow />
              <FollowUpRow />
            </SettingsGroupBlock>

            <SettingsGroupBlock label={t("settings.group.sidebar")} stack>
              <SidebarToolsLayoutRow />
              <ShowThreadsRow />
              <PinnedCirclesRow />
              <UniversalPinsRow />
            </SettingsGroupBlock>

            <SettingsGroupBlock label={t("notifications.title")} stack>
              <NotificationRows />
            </SettingsGroupBlock>
          </>
        );
      case "experimental":
        return <ExperimentalFeaturesRow />;
      case "connections":
        return <AdminOnly><KeysPage /></AdminOnly>;
      case "decisionModel": return <AdminOnly><DecisionModelSettings /></AdminOnly>;
      case "imageGeneration": return <AdminOnly><ImageGenerationSettings /></AdminOnly>;
      case "videoGeneration": return <AdminOnly><VideoGenerationSettings /></AdminOnly>;
      case "engines": return <AdminOnly><div className="flex flex-col gap-6"><ModelManagement /><EngineMaintenance /></div></AdminOnly>;
      case "backups":
        return (
          <>
            <AdminOnly><WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly>
            <SettingsGroupBlock label={t("settings.simple.more.limits")} block="limits" stack>
              <AttachmentStorageSettings />
              <Card title={t("settings.roomTurns.title")} subtitle={t("settings.roomTurns.subtitle")}>
                <RoomTurnTimeoutSettings />
              </Card>
              <Card title={t("settings.mcpCalls.title")} subtitle={t("settings.mcpCalls.subtitle")}>
                <McpCallTimeoutSettings />
              </Card>
              <ThreadConcurrencySettings />
              <AutomaticRecoverySettings />
              <ThreadCleanupSettings />
              <SavedStepsRow />
              <PhoneVerifyRow />
            </SettingsGroupBlock>
          </>
        );
      case "import": return <AdminOnly><ImportSettings /></AdminOnly>;
      case "companion":
        return <>{remoteAccess.companion}{remoteAccess.pairing}{remoteAccess.domain}{window.ogb?.environments ? null : remoteAccess.client}</>;
      case "computer":
        return <><BuiltInBrowserRow /><ServerSitesRow /><BrowserProfilesRow /><AdminOnly><LocalComputerSection /></AdminOnly></>;
      case "logins":
        return <><VaultSettings /><PaymentCardsSettings /></>;
      case "channels":
        return <ChannelsSettings />;
      case "usage":
        // The Cloud plan's meters sit here, beside the per-provider plans and the trace table, rather than in General
        // where they would be a second place to read the same numbers.
        return <><CloudUsageSettings /><AdminOnly note="settings.adminOnly.usage"><UsageSection /></AdminOnly></>;
      case "skills":
        return skillsLibraryEnabled(state.config) ? <SkillsSection /> : null;
      case "people":
        return <PeopleSection />;
      case "activity":
        return <ActivitySection />;
      case "botAccess":
        return <AccessOverview />;
      case "workspaces":
        return <WorkspacesSection />;
      default:
        return null;
    }
  };

  const renderSimplePage = (page: SimpleSettingsPage) => {
    const has = (id: AppSettingsSection) => page.sections.includes(id);
    switch (page.id) {
      case "general": return <SimpleGeneralPage has={has} disclose={disclose} toolCalls={!remoteActive} />;
      case "team": return <SimpleTeamPage has={has} peopleOpen={section === "people"} />;
      case "ai": return <SimpleAiPage has={has} disclose={disclose} connections={renderSection("connections")}
        imageGeneration={renderSection("imageGeneration")} videoGeneration={renderSection("videoGeneration")} decisionModel={renderSection("decisionModel")} />;
      case "computer": return <SimpleComputerPage has={has} remoteAccess={remoteAccess} servers={<ConnectedWorkspacesSettings />} disclose={disclose} />;
      case "billing": return <SimpleBillingPage has={has} disclose={disclose} cloudAccount={renderSection("cloudAccount")} />;
      case "advanced": return <SimpleAdvancedPage has={has} limits={simpleAvailable.has("general")} />;
      case "updates": return <SimpleUpdatesPage remoteActive={remoteActive} />;
      default:
        return <>{page.sections.map((id) => <section key={id} data-settings-block={id} className="flex scroll-mt-4 flex-col gap-4">{renderSection(id)}</section>)}</>;
    }
  };

  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const searchField = (className: string, inputClassName: string) => (
    <div className={className}>
      <Search size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <input
        data-settings-search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (query) setQuery("");
          else close();
        }}
        placeholder={t("settings.search")}
        aria-label={t("settings.searchAria")}
        className={inputClassName}
      />
    </div>
  );

  /** The field a person types into. Narrow windows have no rail, so theirs sits in the header and its results take over
   * the page below. */
  const narrowSearch = (
    <div className="w-full sm:hidden">
      {searchField(
        "flex h-9 items-center gap-2 rounded-lg bg-ink/[0.05] px-2.5 text-[13px] focus-within:ring-2 focus-within:ring-focus/60",
        "w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none",
      )}
    </div>
  );

  if (!advanced) {
    const resultClass = "flex min-h-8 shrink-0 cursor-pointer items-center rounded-lg px-[9px] py-1.5 text-left text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none";
    const goTo = (id: AppSettingsSection) => openSection(id);
    /** Opens the page a row lives on and scrolls to the row, or to the page's block when Simple draws no such row. */
    const openRow = (entry: SettingsRowEntry) => {
      const page = pageOf(entry.simpleSection ?? entry.section, false, simplePages);
      setQuery("");
      goTo(page);
      setReveal({ rows: entry.titleKeys.map((key) => t(key)), block: entry.simpleSection ?? entry.section });
    };
    const sectionLabel = (id: AppSettingsSection) => {
      const entry = SECTIONS.find((candidate) => candidate.id === id);
      return entry ? t(entry.labelKey) : "";
    };
    const results: SettingsSearchResult[] = [
      ...visiblePages.map((page) => ({ kind: "page" as const, id: page.id, label: t(page.labelKey), icon: page.icon, current: page === currentPage, select: () => goTo(page.sections[0]!) })),
      ...pageRowMatches.map((entry) => ({ kind: "row" as const, id: entry.titleKeys[0], label: t(entry.titleKeys[0]), hint: sectionLabel(entry.simpleSection ?? entry.section), select: () => openRow(entry) })),
      ...looksMatches.map((entry) => ({ kind: "advanced" as const, id: entry.titleKeys[0], label: t(entry.titleKeys[0]), hint: t("settings.simple.looks.title"),
        select: () => { setQuery(""); goTo("general"); setFolds((current) => ({ ...current, "looks-more": true })); setReveal({ rows: entry.titleKeys.map((key) => t(key)), block: "looks" }); } })),
      ...moreMatches.map((entry) => ({ kind: "more" as const, id: entry.titleKeys[0], label: t(entry.titleKeys[0]), hint: t("settings.simple.more.limits"),
        select: () => { setQuery(""); goTo("backups"); setReveal({ rows: entry.titleKeys.map((key) => t(key)), block: "limits" }); } })),
      ...keyResults.map((entry) => ({ kind: "key" as const, id: entry.id, label: t(entry.labelKey), hint: t(keySection(entry).titleKey),
        select: () => { setQuery(""); dispatch(openKeyResult(entry)); } })),
    ];
    const noMatch = results.length === 0;
    /** Every result sits in one list, so the page entries keep the rail's 32px row and the rest get the result look. */
    const railResultClass = (result: SettingsSearchResult) => result.kind === "page"
      ? cn("flex h-8 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] text-left text-[13px] text-ink transition-colors motion-reduce:transition-none",
        result.current ? "bg-ink/[0.08]" : "hover:bg-ink/[0.06]")
      : resultClass;
    return (
      <div
        className="glass-popup-frame"
        data-settings-sheet
        data-settings-look="simple"
        style={glassPopupFrameStyle()}
        onMouseDown={(e) => e.target === e.currentTarget && close()}
      >
        <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-settings-title"
          tabIndex={-1}
          style={{ outline: "none" }}
          className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-2xl text-ink"
        >
          <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
          <nav aria-label={t("settings.title")} className="glass-rail hidden min-h-0 w-[198px] shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-4 sm:flex">
            {searchField(
              "mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-[9px] text-[13px] focus-within:ring-2 focus-within:ring-focus/60",
              "w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none",
            )}
            {noMatch && (
              <div className="px-[9px] py-3 text-[13px] leading-[18px] text-ink-secondary">{t("settings.noMatch", { query: query.trim() })}</div>
            )}
            {results.map((result) => <SearchResultButton key={`${result.kind}:${result.id}`} result={result} className={railResultClass(result)} />)}
          </nav>

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 flex-col gap-2 py-3 pl-4 pr-14 sm:flex-row sm:items-center sm:gap-3 sm:pb-2 sm:pl-8 sm:pt-7">
              {narrowSearch}
              <div className="flex min-w-0 items-center gap-3">
                <Select className="min-w-0 sm:hidden"
                  aria-label={t("settings.title")}
                  value={currentPage?.id ?? ""}
                  onChange={(event) => {
                    setQuery("");
                    const page = simplePages.find((candidate) => candidate.id === event.target.value);
                    if (page) goTo(page.sections[0]!);
                  }}
                >
                  {simplePages.map((page) => (
                    <option key={page.id} value={page.id}>{t(page.labelKey)}</option>
                  ))}
                </Select>
                <h2 className="hidden truncate text-[17px] font-medium leading-6 tracking-[-0.008em] text-ink sm:block">
                  {currentPage ? t(currentPage.labelKey) : null}
                </h2>
              </div>
            </header>
            <button
              type="button"
              onClick={close}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="settings-close-btn absolute right-5 top-[18px] flex size-9 cursor-pointer items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none"
            >
              <X size={16} aria-hidden="true" />
            </button>

            {q && (
              <div className="settings-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-10 sm:hidden">
                {results.length === 0
                  ? <div className="py-3 text-[13px] leading-[18px] text-ink-secondary">{t("settings.noMatch", { query: query.trim() })}</div>
                  : results.map((result) => <SearchResultButton key={`${result.kind}:${result.id}`} result={result} className={resultClass} />)}
              </div>
            )}
            <div
              ref={scrollRef}
              data-settings-scroll
              className={cn(
                "settings-scroll min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-10 pt-4 sm:flex sm:px-8 sm:pb-12 sm:pt-[22px]",
                q ? "hidden sm:flex" : "flex",
                SIMPLE_BUTTONS,
                "[&_.uppercase]:normal-case [&_.uppercase]:tracking-normal",
              )}
            >
              <LicenseExpiryBanner config={state.config} />
              {currentPage ? renderSimplePage(currentPage) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="glass-popup-frame"
      data-settings-sheet
      data-settings-look="advanced"
      style={glassPopupFrameStyle()}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-2xl outline-none"
      >
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav aria-label={t("settings.title")} className="glass-rail hidden min-h-0 w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-4 sm:flex">
          <div className="shrink-0 px-3 pb-2.5 pt-1 text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {t("settings.title")}
          </div>
          {searchField(
            "mb-2 flex h-8 shrink-0 items-center gap-2 rounded-xl bg-ink/[0.05] px-2.5 text-[13px] focus-within:ring-2 focus-within:ring-focus/60",
            "w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none",
          )}
          {visiblePages.length === 0 && keyResults.length === 0 && advancedRowResults.length === 0 && (
            <div className="px-3 py-4 text-[13px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {visiblePages.map((page) => {
            const Icon = page.icon;
            const isCurrent = page === currentPage;
            return (
              <button
                key={page.id}
                type="button"
                data-settings-page={page.id}
                onClick={() => openSection(page.sections[0]!)}
                aria-current={isCurrent ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-[13.5px] text-ink transition-colors motion-reduce:transition-none",
                  isCurrent ? "bg-ink/[0.08] font-medium" : "hover:bg-ink/[0.05]",
                )}
              >
                <Icon size={17} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", isCurrent ? "text-ink" : "text-ink-secondary")} />
                <span className="truncate">{t(page.labelKey)}</span>
              </button>
            );
          })}
          {keyResultButtons("cursor-pointer flex min-h-9 items-center rounded-xl px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-ink/[0.05] motion-reduce:transition-none")}
          {advancedRowResults.map((entry) => (
            <SearchResultButton
              key={entry.titleKeys[0]}
              result={advancedResults.find((result) => result.kind === "row" && result.id === entry.titleKeys[0])!}
              className="cursor-pointer flex min-h-9 items-center rounded-xl px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-ink/[0.05] motion-reduce:transition-none"
            />
          ))}
        </nav>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-col gap-2 py-3 pl-4 pr-14 sm:flex-row sm:items-center sm:gap-3 sm:pb-2 sm:pl-9 sm:pt-7">
            {narrowSearch}
            <div className="flex min-w-0 items-center gap-3">
              <Select className="min-w-0 sm:hidden"
                aria-label={t("settings.title")}
                value={currentPage?.id ?? ""}
                onChange={(event) => {
                  setQuery("");
                  const page = advancedPages.find((candidate) => candidate.id === event.target.value);
                  if (page) openSection(page.sections[0]!);
                }}
              >
                {advancedPages.map((page) => (
                  <option key={page.id} value={page.id}>{t(page.labelKey)}</option>
                ))}
              </Select>
              <h2 className="hidden truncate text-[18px] font-semibold leading-6 tracking-[-0.01em] text-ink sm:block">
                {sectionLabelKey ? t(sectionLabelKey) : null}
              </h2>
            </div>
          </header>
          <button
            type="button"
            onClick={close}
            aria-label={t("settings.close")}
            title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
            className="settings-close-btn absolute right-5 top-[18px] flex size-9 cursor-pointer items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none"
          >
            <X size={16} aria-hidden="true" />
          </button>

          {q && (
            <div className="settings-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4 pb-10 sm:hidden">
              {advancedResults.length === 0
                ? <div className="py-3 text-[13px] leading-relaxed text-ink-secondary">{t("settings.noMatch", { query: query.trim() })}</div>
                : advancedResults.map((result) => <SearchResultButton key={`${result.kind}:${result.id}`} result={result} className={cn("flex min-h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink transition-colors motion-reduce:transition-none", result.current ? "bg-ink/[0.08] font-medium" : "hover:bg-ink/[0.05]")} />)}
            </div>
          )}
          <div ref={scrollRef} data-settings-scroll className={cn("settings-scroll min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-10 pt-3 sm:flex sm:px-9 sm:pb-12 sm:pt-4", q ? "hidden sm:flex" : "flex")}>
            <LicenseExpiryBanner config={state.config} />
            {currentPage?.sections.map((id) => (
              <section key={id} data-settings-block={id} className="flex scroll-mt-4 flex-col gap-4">
                {renderSection(id)}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

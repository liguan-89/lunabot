import { pageIsThisComputer } from "@/lib/companion-bridge";
import type { ReactNode } from "react";
import type { AppSettingsSection } from "@/state/store";
import { t } from "@/lib/i18n";
import { appVersion } from "@/lib/app-links";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { productName } from "../lib/brand";
import { AnalyticsRow } from "./AnalyticsRow";
import { UpdatesConsentRow } from "./UpdatesConsent";
import { OpenAtLoginRow } from "./OpenAtLoginRow";
import { DefaultBotSidebarRow } from "./DefaultBotControls";
import { TalkShortcutRow } from "./TalkShortcutRow";
import { AttachmentStorageSettings } from "./AttachmentStorageSettings";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { ModelManagement } from "./ModelManagement";
import { LocalComputerSection } from "./LocalComputerSection";
import { PeopleSection } from "./PeopleSection";
import { ActivitySection } from "./ActivitySection";
import { AccessOverview } from "./bot-access/AccessOverview";
import { BuiltInBrowserRow, ServerSitesRow } from "./BrowserSettingsRows";
import { VaultSettings } from "./VaultSettings";
import { PaymentCardsSettings } from "./PaymentCardsSettings";
import { ChannelsSettings } from "./ChannelsSettings";
import { OrganizationSettings } from "./OrganizationSettings";
import { CloudPlanRow, CloudPlanFootnote, useCloudPlan } from "./ProIntroduction";
import { CloudUsageDetails, CloudUsageSummaryView, useCloudUsageSettings } from "./CloudUsageMeter";
import { Card, SettingRow, SettingsDisclosureRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { PlanUsageSummary } from "./PlanUsage";
import { SkinPicker } from "./SkinPicker";
import { PlaceLookRows } from "./PlaceLookCard";
import { ChromeRailRow } from "./ChromeRailToggle";
import { WindowFrameRow } from "./WindowFrameRow";
import { ProfileSummaryRow } from "./ProfileSettings";
import { AwayEmailsSetting } from "./AwayEmailsSetting";
import { ImportSettings } from "./ImportSettings";
import { NotificationRows } from "./NotificationSettingsRows";
import { useServerUpdateItem } from "./SidebarProfileMenu";
import { AdvancedModeRow, BrowserProfilesRow, ColorUserBubblesRow, ExperimentalFeaturesRow, FollowUpRow, LanguageRow, PinnedCirclesRow, ReplayTourRow, RunCardRow, SendKeyRow, ShowThreadsRow, ToolCallsRow, UniversalPinsRow, UpdatesRow } from "./AppSettingsRows";
import { AvatarStyleRow, ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "./AppearanceSelectRows";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { SkillsSection } from "./SkillsSection";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { SavedStepsRow } from "./SavedStepsRow";
import { PhoneVerifyRow } from "./PhoneVerifyRow";
import { ThemeRow } from "./ThemeRow";
import { AdminOnly } from "./AdminOnly";
import { DefaultBotSettings } from "./NewBotDialog";

export type SimpleDisclosureId = "ai-more" | "ai-keys" | "ai-images" | "ai-videos" | "ai-decision" | "looks-more" | "computer-elsewhere" | "billing-limits";

export type Disclose = (id: SimpleDisclosureId) => { id: SimpleDisclosureId; open: boolean; onToggle: () => void };

type Has = (id: AppSettingsSection) => boolean;

export function SimpleGeneralPage({ has, disclose, toolCalls = true }: { has: Has; disclose: Disclose; toolCalls?: boolean }) {
  return (
    <>
      {has("general") && (
        <SettingsGroup label={t("settings.group.account")} block="general">
          <SettingsRows>
            <ProfileSummaryRow />
            <AwayEmailsSetting row />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("settings.section.appearance")} block="appearance">
          <SettingsRows>
            <ThemeRow simple />
            <PlaceLookRows />
            <ChromeRailRow />
            <WindowFrameRow />
            <ColorUserBubblesRow simple />
          </SettingsRows>
          <SettingsDisclosureRow title={t("settings.simple.looks.title")} block="looks" {...disclose("looks-more")}>
            <SkinPicker />
            <AvatarStyleRow />
            <SettingsRows>
              {toolCalls && <ToolCallsRow />}
              <FontRow />
              <ChatWidthRow />
              <ShowThreadsRow />
              <PinnedCirclesRow />
              <UniversalPinsRow />
              <SidebarToolsLayoutRow />
              <RunCardRow />
            </SettingsRows>
          </SettingsDisclosureRow>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("settings.simple.group.typing")}>
          <SettingsRows>
            <LanguageRow simple />
            <SendKeyRow simple />
            <FollowUpRow simple />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("appearance") && (
        <SettingsGroup label={t("notifications.title")}>
          <SettingsRows><NotificationRows simple /></SettingsRows>
        </SettingsGroup>
      )}
      {has("general") && (
        <SettingsGroup label={t("settings.simple.group.system")}>
          <SettingsRows>
            <OpenAtLoginRow simple />
            <DefaultBotSidebarRow simple />
            <TalkShortcutRow />
            <AttachmentStorageSettings />
            <AnalyticsRow simple />
          </SettingsRows>
        </SettingsGroup>
      )}
      {has("import") && <SettingsGroup label={t("settings.section.import")} block="import"><AdminOnly><ImportSettings /></AdminOnly></SettingsGroup>}
      {!SIMPLE_ONLY && <div data-settings-block="advanced-mode" className="scroll-mt-4">
        <SettingsRows><AdvancedModeRow simple /></SettingsRows>
      </div>}
    </>
  );
}

/** Who is in the team, which bots they reach, the organization behind it and what they changed. A solo install has none of
 * these, and the page is not offered. */
export function SimpleTeamPage({ has, peopleOpen }: { has: Has; peopleOpen: boolean }) {
  return (
    <>
      {has("people") && (
        <SettingsGroup label={t("settings.section.people")} block="people">
          <SettingsRows><PeopleSection simple startOpen={peopleOpen} /></SettingsRows>
        </SettingsGroup>
      )}
      {has("botAccess") && <SettingsGroup label={t("settings.section.botAccess")} block="botAccess"><AccessOverview /></SettingsGroup>}
      {has("organization") && <SettingsGroup label={t("settings.section.organization")} block="organization"><OrganizationSettings /></SettingsGroup>}
      {has("activity") && <SettingsGroup label={t("settings.section.activity")} block="activity"><ActivitySection /></SettingsGroup>}
    </>
  );
}

/** Everything that changes how the bots behave when nobody is watching, plus the rare restores. It used to be a second
 * level under General; it is a page of its own so a search result opens straight onto it. The limits are General's
 * settings, so they appear only where General does. */
export function SimpleAdvancedPage({ has, limits }: { has: Has; limits: boolean }) {
  return (
    <>
      {limits && (
        <SettingsGroup label={t("settings.simple.more.limits")} block="limits" stack>
          <Card title={t("settings.roomTurns.title")} subtitle={t("settings.roomTurns.subtitle")}><RoomTurnTimeoutSettings /></Card>
          <Card title={t("settings.mcpCalls.title")} subtitle={t("settings.mcpCalls.subtitle")}><McpCallTimeoutSettings /></Card>
          <ThreadConcurrencySettings />
          <AutomaticRecoverySettings />
          <ThreadCleanupSettings />
          <SettingsRows><SavedStepsRow /><PhoneVerifyRow /></SettingsRows>
        </SettingsGroup>
      )}
      {has("backups") && <SettingsGroup block="backups" stack><AdminOnly><WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly></SettingsGroup>}
      {has("experimental") && <SettingsGroup block="experimental"><ExperimentalFeaturesRow /></SettingsGroup>}
    </>
  );
}

export function SimpleAiPage({ has, disclose, connections, decisionModel, imageGeneration, videoGeneration }: {
  has: Has;
  disclose: Disclose;
  connections: ReactNode;
  decisionModel: ReactNode;
  imageGeneration: ReactNode;
  videoGeneration?: ReactNode;
}) {
  return (
    <>
      {has("engines") && (
        <div data-settings-block="engines" className="flex scroll-mt-4 flex-col gap-7">
          <AdminOnly>
            <ModelManagement />
            <SettingsRows><DefaultBotSettings simple /></SettingsRows>
          </AdminOnly>
        </div>
      )}
      {has("connections") && (
        <AdminOnly>
          <SettingsDisclosureRow title={t("settings.section.connections")} block="connections" {...disclose("ai-keys")}>
            {connections}
          </SettingsDisclosureRow>
        </AdminOnly>
      )}
      {has("imageGeneration") && (
        <AdminOnly>
          <SettingsDisclosureRow title={t("settings.section.imageGeneration")} block="imageGeneration" {...disclose("ai-images")}>
            {imageGeneration}
          </SettingsDisclosureRow>
        </AdminOnly>
      )}
      {has("videoGeneration") && videoGeneration && (
        <AdminOnly>
          <SettingsDisclosureRow title={t("settings.section.videoGeneration")} block="videoGeneration" {...disclose("ai-videos")}>
            {videoGeneration}
          </SettingsDisclosureRow>
        </AdminOnly>
      )}
      {has("decisionModel") && (
        <AdminOnly>
          <SettingsDisclosureRow title={t("settings.section.decisionModel")} block="decisionModel" {...disclose("ai-decision")}>
            {decisionModel}
          </SettingsDisclosureRow>
        </AdminOnly>
      )}
      {has("skills") && <SettingsGroup block="skills"><SkillsSection /></SettingsGroup>}
    </>
  );
}

export type RemoteAccessCards = Record<"client" | "domain" | "pairing" | "companion", ReactNode>;

export function SimpleComputerPage({ has, remoteAccess, servers, disclose }: { has: Has; remoteAccess: RemoteAccessCards; servers: ReactNode; disclose: Disclose }) {
  return (
    <>
      {has("computer") && <SettingsGroup label={t("settings.simple.computer.bots")} block="computer"><AdminOnly><LocalComputerSection /></AdminOnly></SettingsGroup>}
      {has("companion") && (
        <SettingsGroup label={t(pageIsThisComputer() ? "settings.section.phoneDevices" : "settings.section.thisServer")} block="companion">
          {remoteAccess.companion}
          {remoteAccess.pairing}
          {remoteAccess.domain}
        </SettingsGroup>
      )}
      {has("computer") && (
        <SettingsGroup label={t("settings.experimental.browser")} block="browser">
          <SettingsRows><BuiltInBrowserRow /><ServerSitesRow /></SettingsRows>
          <BrowserProfilesRow />
        </SettingsGroup>
      )}
      {has("logins") && <div data-settings-block="logins" className="scroll-mt-4"><VaultSettings /><PaymentCardsSettings /></div>}
      {has("channels") && <div data-settings-block="channels" className="scroll-mt-4"><ChannelsSettings /></div>}
      {(has("companion") || has("desktopWorkspaces")) && (
        <SettingsDisclosureRow title={t("settings.simple.computer.elsewhere")} block="elsewhere" {...disclose("computer-elsewhere")}>
          {has("desktopWorkspaces") && <div data-settings-block="desktopWorkspaces" className="flex scroll-mt-4 flex-col gap-4">{servers}</div>}
          {has("companion") && <div data-settings-block="remote" className="flex scroll-mt-4 flex-col gap-4 empty:hidden">{remoteAccess.client}</div>}
        </SettingsDisclosureRow>
      )}
    </>
  );
}

export function SimpleBillingPage({ has, disclose, cloudAccount }: { has: Has; disclose: Disclose; cloudAccount: ReactNode }) {
  const { usage, upgrade, dialog } = useCloudUsageSettings();
  const plan = useCloudPlan();
  const signedOut = plan?.view.kind === "signed-out" || plan?.view.kind === "removed";
  return (
    <>
      <div data-settings-block="usage" className="scroll-mt-4">
        {usage ? <CloudUsageSummaryView usage={usage} upgrade={upgrade}>{dialog}</CloudUsageSummaryView> : <AdminOnly note="settings.adminOnly.usage"><PlanUsageSummary /></AdminOnly>}
      </div>
      {(usage || has("usage")) && (
        <SettingsDisclosureRow title={t("settings.simple.billing.limits")} {...disclose("billing-limits")}>
          {usage && <CloudUsageDetails usage={usage} upgrade={upgrade} />}
          {has("usage") && <AdminOnly note="settings.adminOnly.usage"><UsageSection /></AdminOnly>}
        </SettingsDisclosureRow>
      )}
      {has("cloudAccount") && (
        <SettingsGroup label={t("settings.simple.billing.plan")} block="cloudAccount" footnote={<CloudPlanFootnote />}>
          <SettingsRows><CloudPlanRow usage={usage} upgrade={upgrade} /></SettingsRows>
          {signedOut ? null : <div className="flex flex-col gap-4">{cloudAccount}</div>}
        </SettingsGroup>
      )}
    </>
  );
}

const versionTitle = () => `${productName()} ${appVersion()}`;

function ServerUpdatesRow() {
  const entry = useServerUpdateItem(true);
  if (!entry) return null;
  const status = entry.phase === "idle" ? undefined : [entry.label, entry.item.subtitle].filter(Boolean).join(" ");
  const action = entry.phase === "available" ? t("settings.simple.updates.seeRelease")
    : entry.phase === "reload" ? t("settings.simple.updates.reload")
      : entry.phase === "checking" ? t("common.checking") : t("settings.updates.check");
  return (
    <SettingRow title={versionTitle()} subtitle={status}>
      <button type="button" className="ui-button" disabled={entry.item.disabled} onClick={entry.item.onSelect}>{action}</button>
    </SettingRow>
  );
}

export function SimpleUpdatesPage({ remoteActive }: { remoteActive: boolean }) {
  return (
    <SettingsGroup block="updates">
      <SettingsRows>
        {window.ogb?.updater ? <UpdatesRow title={versionTitle()} /> : <ServerUpdatesRow />}
        <UpdatesConsentRow />
        {!remoteActive && <ReplayTourRow />}
        <DiagnosticsRow simple />
      </SettingsRows>
    </SettingsGroup>
  );
}

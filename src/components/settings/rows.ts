import type { AppSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

/** One row a Settings search can land on.
 *
 * `titleKeys` is the row's visible title — the Advanced wording first, then the Simple one where the two differ — because
 * the row is found by its rendered `data-settings-row` text, not by an id that could drift from it. A row that is not on
 * the page its entry names falls back to that page's block, so a stale entry costs a scroll, never a dead end. */
export type SettingsRowEntry = {
  titleKeys: readonly [LocaleKey, ...LocaleKey[]];
  section: AppSettingsSection;
  keywords?: string[];
  /** Simple draws this row on another section's page than `section` names. */
  simpleSection?: AppSettingsSection;
  /** Simple keeps this row on the Limits and backups page, under its Limits block. */
  simpleMore?: true;
  /** Simple keeps this row behind General's More looks sub-page. */
  simpleLooks?: true;
  /** Drawn only once the server answers, so a static render cannot prove the anchor exists. */
  lazy?: true;
};

/** Rows people search for by their own name. A section's label and keywords still cover everything else; this exists
 * because the page a row lives on is not what the searcher has in mind. */
export const SETTINGS_ROWS: readonly SettingsRowEntry[] = [
  { titleKeys: ["settings.profile.title"], section: "general", keywords: ["name", "email", "avatar", "about me"] },
  { titleKeys: ["settings.profile.awayEmails"], section: "general", keywords: ["away", "vacation", "out of office"], lazy: true },
  { titleKeys: ["pro.name"], section: "general", keywords: ["plan", "subscription", "upgrade", "cloud hours"], lazy: true },
  { titleKeys: ["settings.attachments.title"], section: "backups", simpleSection: "general", keywords: ["files", "storage", "clear", "disk"], lazy: true },
  { titleKeys: ["settings.analytics.title"], section: "general", keywords: ["telemetry", "tracking", "privacy"] },
  { titleKeys: ["settings.openAtLogin.title"], section: "general", keywords: ["startup", "launch", "boot"], lazy: true },
  { titleKeys: ["settings.talk.title"], section: "general", keywords: ["shortcut", "voice", "dictation"], lazy: true },
  { titleKeys: ["webPanels.settings.title"], section: "general", keywords: ["web panel", "pin a page", "dashboard"], simpleLooks: true },
  { titleKeys: ["newBot.defaults"], section: "general", simpleSection: "engines", keywords: ["effort", "new bots", "preset"] },
  { titleKeys: ["settings.roomTurns.title"], section: "backups", keywords: ["group", "timeout", "turn"], simpleMore: true },
  { titleKeys: ["settings.mcpCalls.title"], section: "backups", keywords: ["tool", "timeout", "mcp"], simpleMore: true },
  { titleKeys: ["settings.threads.title"], section: "backups", keywords: ["parallel", "concurrency"], simpleMore: true },
  { titleKeys: ["settings.recovery.title"], section: "backups", keywords: ["fallback", "backup model"], simpleMore: true },
  { titleKeys: ["settings.threadCleanup.title"], section: "backups", keywords: ["retention", "log size"], simpleMore: true },
  { titleKeys: ["settings.savedSteps.title"], section: "backups", keywords: ["repeat", "replay", "computer tasks"], simpleMore: true, lazy: true },
  { titleKeys: ["settings.phoneVerify.title"], section: "backups", keywords: ["phone", "verify", "check", "screen", "claims"], simpleMore: true, lazy: true },
  { titleKeys: ["settings.noticeLearn.title"], section: "backups", keywords: ["phone", "notification", "learn", "topics", "notices"], simpleMore: true, lazy: true },
  { titleKeys: ["settings.advancedMode.title"], section: "general", keywords: ["advanced", "more settings"] },
  { titleKeys: ["settings.theme.title", "settings.theme.lightOrDark"], section: "appearance", keywords: ["dark", "light", "skin", "colour", "color"] },
  { titleKeys: ["placeLook.sidebarColor"], section: "appearance", keywords: ["sidebar", "colour", "color", "swatch"], lazy: true },

  { titleKeys: ["settings.userBubbles.title", "settings.userBubbles.simpleTitle"], section: "appearance", keywords: ["bubble", "color", "colour"] },
  { titleKeys: ["settings.avatarStyle.title"], section: "appearance", keywords: ["avatar", "bot face", "orb", "neko", "synth", "spirit", "minibot", "bunny", "astro", "prism", "bear", "retro", "fox", "frog", "owl", "wisp", "camera", "cloud"], simpleLooks: true },
  { titleKeys: ["settings.font.title"], section: "appearance", keywords: ["typeface", "text size"], simpleLooks: true },
  { titleKeys: ["settings.chatWidth.title"], section: "appearance", keywords: ["wide", "full width", "narrow"], simpleLooks: true },
  { titleKeys: ["settings.threadDisplay.title"], section: "appearance", keywords: ["show threads", "hide threads"], simpleLooks: true },
  { titleKeys: ["settings.pinnedCircles.title"], section: "appearance", keywords: ["pins", "circles"], simpleLooks: true },
  { titleKeys: ["settings.universalPins.title"], section: "appearance", keywords: ["pins", "groups"], simpleLooks: true },
  { titleKeys: ["sidebar.toolsLayout.title"], section: "appearance", keywords: ["toolbar", "footer", "layout"], simpleLooks: true },
  { titleKeys: ["settings.toolCalls.title"], section: "appearance", keywords: ["commands"] },
  { titleKeys: ["settings.runCard.title"], section: "appearance", keywords: ["this run"], simpleLooks: true },
  { titleKeys: ["settings.language.title"], section: "general", keywords: ["locale", "translate"] },
  { titleKeys: ["settings.sendKey.title"], section: "appearance", keywords: ["enter", "return", "shift+enter", "keyboard"] },
  { titleKeys: ["settings.followUp.title"], section: "appearance", keywords: ["queue", "steer", "while busy"] },
  { titleKeys: ["settings.notificationSounds.title"], section: "appearance", keywords: ["sound", "chime", "mute", "silent"] },
  { titleKeys: ["settings.notificationFeed.title"], section: "appearance", keywords: ["bell", "feed"] },
  { titleKeys: ["settings.deviceNotifications.title"], section: "appearance", keywords: ["os notifications", "desktop notifications"], lazy: true },
  { titleKeys: ["settings.updatesConsent.title"], section: "general", simpleSection: "updates", keywords: ["newsletter", "email updates"], lazy: true },
  { titleKeys: ["settings.welcome.title"], section: "general", simpleSection: "updates", keywords: ["tour", "welcome", "onboarding"] },
  { titleKeys: ["settings.diagnostics.title"], section: "general", simpleSection: "updates", keywords: ["logs", "support", "export"] },
  { titleKeys: ["settings.experimental.browserAria"], section: "computer", keywords: ["built-in browser", "chromium"] },
  { titleKeys: ["settings.profiles.title"], section: "computer", keywords: ["browser", "profiles", "cookies"] },
];

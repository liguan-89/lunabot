import {
  Archive, BookOpen, Building2, Cloud, CloudDownload, Coins, CreditCard, Download, Film, FlaskConical, Gauge, ImagePlus,
  KeyRound, LayoutGrid, Lock, LockKeyhole, MessageCircle, Monitor, Palette, ScrollText, Settings, ShieldCheck, Sparkles,
  TabletSmartphone, Terminal, User, Users, Wallet, Zap,
  type LucideIcon,
} from "lucide-react";

import type { AppSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { matchesWords } from "@/lib/search-words";
import { scrollWithin } from "@/lib/scroll-within";
import { talkShortcutKeywords } from "../TalkShortcutRow";
import { KEY_CATALOG, keyMatches } from "../keys/key-catalog";
import { SETTINGS_ROWS, type SettingsRowEntry } from "./rows";
import type { SimpleDisclosureId } from "../SettingsSimplePages";

/** Logical domain each section belongs to. Both Simple and Advanced render flat page lists without group headers. */
export type SettingsGroup = "you" | "ai" | "computers" | "account";

export const SETTINGS_GROUPS: Array<{ id: SettingsGroup; labelKey: LocaleKey }> = [
  { id: "you", labelKey: "settings.group.you" },
  { id: "ai", labelKey: "settings.group.ai" },
  { id: "computers", labelKey: "settings.group.computers" },
  { id: "account", labelKey: "settings.group.account" },
];

// labelKey, not a label: t() reads the active pack when called, so a label resolved at module scope would freeze the
// boot language.
export const SECTIONS: Array<{
  id: AppSettingsSection;
  group: SettingsGroup;
  labelKey: LocaleKey;
  icon: LucideIcon;
  keywords: string[];
}> = [
  { id: "general", group: "you", labelKey: "settings.section.general", icon: User, keywords: ["profile", "pinned panels", "web panel", "dashboard", "pin a page", "name", "email", "about me", "about", "suggestions", "suggested", "memory", "analytics", "updates", "product updates", "newsletter", "email updates", "effort", "new bots", "reasoning", "routines", "conversation", "schedule", "usage", "limit", "plan", "upgrade", "cloud desktop hours", ...talkShortcutKeywords()] },
  { id: "appearance", group: "you", labelKey: "settings.section.appearance", icon: Palette, keywords: ["skin", "theme", "appearance", "font", "typeface", "chat width", "width", "wide", "full width", "bubble", "bubbles", "tools", "tool calls", "threads", "show threads", "hide threads", "sidebar", "display", "run", "this run", "run card", "commands", "notifications", "sound", "sounds", "mute", "silent", "chime", "pinned", "circles", "universal", "groups", "top", "send", "enter", "return", "shift+enter", "ctrl+enter", "cmd+enter", "⌘+enter", "new line", "keyboard", "ime", "japanese", "message color", "my messages", "toolbar", "tools layout", "footer", "routines", "triggers", "team map", "color", "colour", "cloud color", "server color", "tint", "sidebar color", "sidebar picture", "picture", "image", "banner", "background", "computers", "your computers", "rail", "strip", "frame", "window frame", "title bar"] },
  { id: "companion", group: "you", labelKey: "settings.section.companion", icon: TabletSmartphone, keywords: ["companion", "device", "phone", "desktop", "client", "host", "pair", "pairing", "mobile", "https", "secure", "tailscale", "wifi", "remote", "advanced", "domain", "dns", "self-hosted", "server", "caddy"] },
  { id: "engines", group: "ai", labelKey: "settings.section.engines", icon: Terminal, keywords: ["custom", "models", "model providers", "engines", "providers", "cli"] },
  { id: "connections", group: "ai", labelKey: "settings.section.connections", icon: KeyRound, keywords: ["keys", "api", "api key", "api keys", "connections", "composio", "box", "xai", "mistral", "cerebras", "meta", "muse", "vps", "router", "openrouter", "base url", "openai", "anthropic", "groq", "greenference", "tk1688", "opencode", "deepseek", "provider", "lm studio", "lmstudio", "llm studio", "llmstudio", "bionic"] },
  { id: "decisionModel", group: "ai", labelKey: "settings.section.decisionModel", icon: Zap, keywords: ["decision", "extraction", "jev", "typesafe", "cloudflare", "workers ai", "clef", "clairic", "email", "routing", "auto", "rooms", "who answers"] },
  { id: "imageGeneration", group: "ai", labelKey: "settings.section.imageGeneration", icon: ImagePlus, keywords: ["image", "images", "picture", "generate", "avatar", "gpt image", "grok imagine", "gemini", "nano banana", "openrouter", "flux", "backup"] },
  { id: "videoGeneration", group: "ai", labelKey: "settings.section.videoGeneration", icon: Film, keywords: ["video", "videos", "seedance", "ark", "volcengine", "tk1688", "motion", "avatar", "dynamic", "720p"] },
  { id: "skills", group: "ai", labelKey: "settings.section.skills", icon: BookOpen, keywords: ["skills", "library", "assign", "agent skills", "skill md"] },
  { id: "desktopWorkspaces", group: "computers", labelKey: "settings.section.desktopWorkspaces", icon: Building2, keywords: ["workspace", "cloud", "hosted", "vps", "server", "servers", "connect", "pair", "switch", "local"] },
  { id: "computer", group: "computers", labelKey: "settings.section.computer", icon: Monitor, keywords: ["vm", "virtual", "desktop", "browser", "built-in browser", "profiles", "browser profiles"] },
  { id: "logins", group: "computers", labelKey: "settings.section.vault", icon: LockKeyhole, keywords: ["vault", "logins", "login", "passwords", "password", "sign in", "2fa", "one-time code", "totp", "fill_login", "1password", "password manager", "secrets", "secret", "token", ".env", "env", "payment", "card", "cards"] },
  { id: "channels", group: "computers", labelKey: "settings.channels.title", icon: MessageCircle, keywords: ["channels", "message channels", "feishu", "lark", "dingtalk", "wecom", "wechat", "sms", "mailbox", "bot mail", "飞书", "钉钉", "企业微信", "短信", "消息渠道"] },
  { id: "cloudAccount", group: "account", labelKey: "settings.section.cloudAccount", icon: Cloud, keywords: ["cloud", "my cloud", "account", "personal", "sign in", "pro", "subscription", "billing", "sync", "send", "this computer", "bots", "logins", "1password"] },
  { id: "marketSubscription", group: "account", labelKey: "settings.section.marketSubscription", icon: CreditCard, keywords: ["tk1688", "api", "subscription", "token", "quota", "billing", "renew", "key", "provider"] },
  { id: "organization", group: "account", labelKey: "settings.section.organization", icon: Building2, keywords: ["company", "organization", "organisation", "sign in", "enroll", "managed", "models", "disconnect"] },
  { id: "usage", group: "account", labelKey: "settings.section.usage", icon: Coins, keywords: ["tokens", "cost", "billing", "plan", "quota", "remaining", "weekly", "5-hour", "model", "used"] },
  { id: "backups", group: "account", labelKey: "settings.section.backups", icon: Archive, keywords: ["export", "import", "restore", "full backup", "password", "recovery", "threads", "parallel", "concurrency", "cleanup", "retention", "attachments", "clear attachments", "event log", "event-log", "log size", "automatic recovery", "backup model", "fallback", "storage", "saved steps", "repeat", "replay", "computer tasks", "without ai", "forget"] },
  { id: "import", group: "account", labelKey: "settings.section.import", icon: Download, keywords: ["import", "grok", "grok bot", "move", "cursor", "claude code", "codex", "gemini", "skills", "mcp", "tools", "bring"] },
  { id: "people", group: "account", labelKey: "settings.section.people", icon: Users, keywords: ["people", "users", "invite", "sign in", "members", "admins", "access"] },
  { id: "botAccess", group: "account", labelKey: "settings.section.botAccess", icon: Users, keywords: ["access", "share", "sharing", "who can", "view", "chat", "edit", "permissions", "team", "members", "bots"] },
  { id: "activity", group: "account", labelKey: "settings.section.activity", icon: ScrollText, keywords: ["activity", "audit", "log", "history", "who changed", "approvals", "decisions", "admin"] },
  { id: "workspaces", group: "account", labelKey: "settings.section.workspaces", icon: Building2, keywords: ["clients", "tenants", "fleet", "workspaces", "installation", "installations"] },
  { id: "experimental", group: "account", labelKey: "settings.section.experimental", icon: FlaskConical, keywords: ["early", "preview", "learn", "skill", "authoring"] },
];

export type SimpleSettingsPage = {
  id: string;
  labelKey: LocaleKey;
  icon: LucideIcon;
  sections: AppSettingsSection[];
  keywords?: string[];
};

/** Advanced's flat Muse-style pages. Every section `SECTIONS` offers is filed under exactly one page so deep links and
 * search land on the right block without fragmenting the sidebar into 20+ micro-entries. */
export const ADVANCED_PAGES: SimpleSettingsPage[] = [
  { id: "general", labelKey: "settings.section.general", icon: Settings, sections: ["general"],
    keywords: ["account", "profile", "language", "open at login", "startup", "analytics", "updates", "diagnostics", "tour", "advanced mode"] },
  { id: "appearance", labelKey: "settings.section.appearance", icon: Palette, sections: ["appearance"],
    keywords: ["theme", "skin", "font", "avatar", "notifications", "sidebar", "chat width", "window frame"] },
  { id: "ai", labelKey: "settings.advanced.page.ai", icon: Sparkles, sections: ["engines", "decisionModel", "imageGeneration", "videoGeneration"],
    keywords: ["models", "providers", "engines", "decision", "extraction", "image", "video", "seedance"] },
  { id: "connectors", labelKey: "settings.advanced.page.connectors", icon: LayoutGrid, sections: ["connections", "skills"],
    keywords: ["connectors", "api keys", "keys", "skills", "mcp", "composio", "integrations"] },
  { id: "computer", labelKey: "settings.advanced.page.computer", icon: Monitor, sections: ["computer"],
    keywords: ["computer use", "desktop", "vm", "browser", "built-in browser", "profiles"] },
  { id: "vault", labelKey: "settings.advanced.page.vault", icon: ShieldCheck, sections: ["logins"],
    keywords: ["vault", "secure storage", "logins", "passwords", "secrets", "1password", "cards", "payment"] },
  { id: "channels", labelKey: "settings.advanced.page.channels", icon: MessageCircle, sections: ["channels"],
    keywords: ["channels", "feishu", "dingtalk", "wecom", "sms", "mailbox", "飞书", "钉钉", "企业微信"] },
  { id: "devices", labelKey: "settings.advanced.page.devices", icon: TabletSmartphone, sections: ["companion", "desktopWorkspaces"],
    keywords: ["devices", "phone", "pairing", "remote access", "servers", "workspaces", "tailscale", "domain"] },
  { id: "data", labelKey: "settings.advanced.page.data", icon: Lock, sections: ["backups", "import"],
    keywords: ["data controls", "backups", "restore", "export", "import", "attachments", "limits", "timeout", "concurrency", "cleanup", "recovery"] },
  { id: "billing", labelKey: "settings.advanced.page.billing", icon: Wallet, sections: ["usage", "cloudAccount", "marketSubscription"],
    keywords: ["wallet", "usage", "billing", "cloud", "subscription", "tk1688", "quota", "plan"] },
  { id: "team", labelKey: "settings.advanced.page.team", icon: Users, sections: ["people", "botAccess", "organization", "activity", "workspaces"],
    keywords: ["team", "permissions", "people", "members", "admins", "bot access", "organization", "activity", "audit", "installations"] },
  { id: "experimental", labelKey: "settings.section.experimental", icon: FlaskConical, sections: ["experimental"],
    keywords: ["experimental", "preview", "early", "skill authoring"] },
];

/** Simple's pages. Every section `SECTIONS` offers is filed under exactly one of them, so nothing is reachable in only
 * one of the two modes. */
export const SIMPLE_PAGES: SimpleSettingsPage[] = [
  { id: "general", labelKey: "settings.section.general", icon: Settings, sections: ["general", "appearance", "import"],
    keywords: ["account", "theme", "looks", "open at login", "startup", "analytics", "advanced mode", "limits", "timeout"] },
  { id: "team", labelKey: "settings.group.team", icon: Users, sections: ["people", "botAccess", "organization", "activity", "workspaces"],
    keywords: ["people", "invite", "members", "admins", "access", "sharing", "audit", "log", "who changed", "company", "installations", "fleet"] },
  { id: "ai", labelKey: "settings.group.ai", icon: Sparkles, sections: ["engines", "decisionModel", "imageGeneration", "videoGeneration", "skills", "connections"],
    keywords: ["new bots", "defaults", "effort", "images", "videos", "seedance", "extraction", "skills"] },
  { id: "computer", labelKey: "settings.simple.page.computer", icon: Monitor, sections: ["companion", "desktopWorkspaces", "computer", "logins", "channels"] },
  { id: "billing", labelKey: "settings.simple.page.billing", icon: Gauge, sections: ["usage", "cloudAccount", "marketSubscription"], keywords: ["billing", "included", "allowance", "cloud hours", "voice", "tk1688", "api subscription"] },
  { id: "advanced", labelKey: "settings.simple.page.limitsBackups", icon: FlaskConical, sections: ["backups", "experimental"],
    keywords: ["limits", "timeout", "concurrency", "retention", "backup", "restore", "export", "experimental", "preview"] },
  { id: "updates", labelKey: "settings.simple.page.updates", icon: CloudDownload, sections: ["updates"],
    keywords: ["update", "version", "release", "product updates", "newsletter", "email updates", "welcome", "tour", "diagnostics", "logs", "support"] },
];

/** A deep link to one of these opens the fold that holds it, rather than the top of its page. */
export const SIMPLE_FOLDED: Partial<Record<AppSettingsSection, SimpleDisclosureId>> = {
  connections: "ai-keys",
  decisionModel: "ai-decision",
  imageGeneration: "ai-images",
  videoGeneration: "ai-videos",
  remote: "computer-elsewhere",
  desktopWorkspaces: "computer-elsewhere",
};

/** The pages this window can offer: a page with no available section is dropped, not drawn empty. */
export function simpleSettingsPages(available: ReadonlySet<AppSettingsSection>): SimpleSettingsPage[] {
  return SIMPLE_PAGES
    .map((page) => ({ ...page, sections: page.sections.filter((id) => available.has(id)) }))
    .filter((page) => page.sections.length > 0);
}

/** The flat Advanced pages this window can offer: empty pages are dropped automatically. */
export function advancedSettingsPages(available: ReadonlySet<AppSettingsSection>): SimpleSettingsPage[] {
  return ADVANCED_PAGES
    .map((page) => ({ ...page, sections: page.sections.filter((id) => available.has(id)) }))
    .filter((page) => page.sections.length > 0);
}

/** Scrolls a scroller to a section's block; index 0 means the top of the page. */
export function revealSettingsBlock(
  scroller: Parameters<typeof scrollWithin>[0] & { querySelector: (selector: string) => Parameters<typeof scrollWithin>[1] | null },
  section: AppSettingsSection,
  indexInPage: number,
): void {
  if (indexInPage <= 0) { scroller.scrollTop = 0; return; }
  const block = scroller.querySelector(`[data-settings-block="${section}"]`);
  if (block) scrollWithin(scroller, block);
}

export function simplePageMatches(page: SimpleSettingsPage, query: string): boolean {
  if (!query) return true;
  if (matchesWords([t(page.labelKey), ...page.keywords ?? []], query)) return true;
  return page.sections.some((id) => {
    const entry = SECTIONS.find((candidate) => candidate.id === id);
    return entry ? sectionMatches(entry, query) : false;
  });
}

export function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  if (section.id === "connections" && KEY_CATALOG.some((entry) => entry.id !== "openaiCompat" && keyMatches(entry, query))) return true;
  return matchesWords([t(section.labelKey), ...section.keywords], query);
}

function rowMatches(entry: SettingsRowEntry, query: string): boolean {
  return matchesWords([...entry.titleKeys.map((key) => t(key)), ...entry.keywords ?? []], query);
}

/** Rows whose own title or words match, limited to the sections this window actually offers. */
export function rowSearchResults(query: string, available: ReadonlySet<AppSettingsSection>): SettingsRowEntry[] {
  return query ? SETTINGS_ROWS.filter((entry) => available.has(entry.section) && rowMatches(entry, query)) : [];
}

/** A row's page in the mode on show: returns the first section of the owning page in `pages`. */
export function pageOf(section: AppSettingsSection, _advanced: boolean, pages: readonly SimpleSettingsPage[]): AppSettingsSection {
  return pages.find((page) => page.sections.includes(section))?.sections[0] ?? section;
}

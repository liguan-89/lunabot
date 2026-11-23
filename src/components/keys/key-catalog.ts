import { AudioLines, Blocks, CalendarClock, Fingerprint, Image, LockKeyhole, Monitor, Phone, Search, Server, Zap, type LucideIcon } from "lucide-react";
import type { AppSettingsSection, ConfigStatus } from "@/state/store";
import type { SavedKey } from "@/state/config-status";
import type { KeyProvider } from "@/lib/analytics-allowlist";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ProviderIconPreset } from "../../../shared/provider-icon";

export type KeySectionId = "ai" | "servers" | "voice" | "computers" | "apps" | "helpers";

export const KEY_SECTIONS: ReadonlyArray<{ id: KeySectionId; titleKey: LocaleKey; purposeKey: LocaleKey }> = [
  { id: "ai", titleKey: "keys.section.ai", purposeKey: "keys.section.ai.purpose" },
  { id: "servers", titleKey: "keys.section.servers", purposeKey: "keys.section.servers.purpose" },
  { id: "voice", titleKey: "keys.section.voice", purposeKey: "keys.section.voice.purpose" },
  { id: "computers", titleKey: "keys.section.computers", purposeKey: "keys.section.computers.purpose" },
  { id: "apps", titleKey: "keys.section.apps", purposeKey: "keys.section.apps.purpose" },
  { id: "helpers", titleKey: "keys.section.helpers", purposeKey: "keys.section.helpers.purpose" },
];

export type TestableProvider = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "tk1688" | "meta" | "treg";

export type DesktopSlot = Parameters<NonNullable<NonNullable<Window["ogb"]>["setCredential"]>>[0];
export type DesktopSlotOptions = NonNullable<Parameters<NonNullable<NonNullable<Window["ogb"]>["setCredential"]>>[2]>;

export interface SavedState { configured: boolean; last4?: string; included?: boolean }

export interface KeyTarget {
  patch: (value: string, firstKey: boolean) => Record<string, unknown>;
  slot?: DesktopSlot;
  storeOptions?: (value: string, firstKey: boolean) => DesktopSlotOptions | undefined;
  saved: (config: ConfigStatus) => SavedState;
  placeholder: string;
  placeholderKey?: LocaleKey;
  href?: string;
  test?: TestableProvider;
  /** The address the check sends the key to, when it is set beside the key: a new address checks the saved key again. */
  testAt?: (config: ConfigStatus) => string | undefined;
  verifiedOnSave?: boolean;
  analytics: KeyProvider;
  shape?: RegExp;
  warningKey?: LocaleKey;
  noteKey?: LocaleKey;
  /** A sponsor's row: the Settings page's own uses of it, for its product event. */
  settingsEvent?: (action: "get_key" | "add_key") => void;
}

export type KeyId =
  | "openai" | "anthropic" | "xai" | "openrouter" | "mistral" | "cerebras" | "groq" | "greenference" | "tk1688" | "meta" | "deepseek" | "opencodeGo" | "opencodeProviders"
  | "lmStudio" | "openaiCompat" | "liveCalls" | "liveKey" | "elevenlabs" | "fishAudio" | "geminiTts" | "box" | "vps" | "onePassword" | "composio" | "treg" | "postiz"
  | "jev" | "openrouterHelper" | "workersAi" | "imageOpenai" | "imageGemini" | "imageCustom";

export type KeyMark = { driverKind: string; preset?: ProviderIconPreset } | { icon: LucideIcon };

export interface KeyEntry {
  id: KeyId;
  section: KeySectionId;
  labelKey: LocaleKey;
  purposeKey: LocaleKey;
  name: string;
  env: readonly string[];
  words: readonly string[];
  mark: KeyMark;
  kind: "key" | "uses" | "panel" | "elsewhere";
  target?: KeyTarget;
  uses?: KeyId;
  opens?: AppSettingsSection;
  whereKey?: LocaleKey;
  status?: (config: ConfigStatus) => SavedState;
}

function flag(saved: SavedKey | undefined): SavedState {
  return { configured: saved?.configured === true, ...(saved?.configured && saved.last4 ? { last4: saved.last4 } : {}) };
}

type TopLevelKey = "openai" | "openrouter" | "xai" | "mistral" | "cerebras" | "groq" | "greenference" | "tk1688" | "meta" | "deepseek" | "treg";

function providerKey(name: TopLevelKey, rest: Omit<KeyTarget, "patch" | "saved">): KeyTarget {
  return { patch: (value) => ({ [name]: { key: value } }), saved: (config) => flag(config[name]), ...rest };
}

const OPENAI_SHAPE = /^sk-(proj|svcacct|admin)-/;
const provider = (driverKind: string, preset?: ProviderIconPreset): KeyMark => ({ driverKind, ...(preset ? { preset } : {}) });

export const KEY_CATALOG: readonly KeyEntry[] = [
  { id: "openaiCompat", section: "ai", labelKey: "keys.openaiCompat.label", purposeKey: "keys.purpose.openaiCompat", name: "Custom", env: ["OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_URL"],
    words: ["openai-compatible", "openai compatible", "ollama", "together", "venice", "gemini", "google ai studio", "base url", "server", "endpoint", "custom", "responses", "anthropic"], mark: { icon: Server }, kind: "key",
    target: { patch: (value) => ({ openaiCompat: { key: value } }), slot: "openaiCompatApiKey", saved: (config) => flag(config.openaiCompat), placeholder: "…", placeholderKey: "keys.openaiCompat.placeholder",
      href: "https://platform.openai.com/docs/api-reference", test: "openaiCompat", testAt: (config) => config.openaiCompat?.url, analytics: "openai_compat" } },
  { id: "liveKey", section: "voice", labelKey: "keys.label.liveKey", purposeKey: "keys.purpose.liveKey", name: "OpenAI", env: ["LUNABOT_OPENAI_LIVE_KEY"],
    words: ["openai", "live calls", "calls", "voice", "gpt-live", "azure", "foundry"], mark: { icon: Phone }, kind: "key",
    target: { patch: (value) => ({ live: { key: value } }), slot: "openaiLiveKey",
      saved: (config) => flag(config.savedKeys?.openaiLiveKey ?? { configured: config.live?.keySource === "live" }),
      placeholder: "sk-…", href: "https://platform.openai.com/api-keys", analytics: "openai_live", shape: OPENAI_SHAPE } },
  { id: "elevenlabs", section: "voice", labelKey: "keys.label.elevenlabs", purposeKey: "keys.purpose.elevenlabs", name: "ElevenLabs", env: ["LUNABOT_TTS_KEY"],
    words: ["elevenlabs", "eleven labs", "voice", "voices", "speech", "tts"], mark: { icon: AudioLines }, kind: "key",
    target: { patch: (value) => ({ tts: { key: value } }), slot: "ttsKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.savedKeys?.ttsKey ?? { configured: config.tts?.provider === "elevenlabs" && config.tts.configured && !config.tts.included }),
        ...(config.tts?.included ? { included: true } : {}) }),
      placeholder: "sk_…", href: "https://elevenlabs.io/app/settings/api-keys", analytics: "elevenlabs", shape: /^sk_/ } },
  { id: "geminiTts", section: "voice", labelKey: "keys.label.geminiTts", purposeKey: "keys.purpose.geminiTts", name: "Gemini", env: ["LUNABOT_GEMINI_API_KEY"],
    words: ["google", "gemini", "speech", "voice", "tts"], mark: { icon: AudioLines }, kind: "key",
    target: { patch: (value) => ({ tts: { geminiKey: value } }), slot: "geminiTtsKey",
      saved: (config) => flag(config.savedKeys?.geminiTtsKey), placeholderKey: "voice.gemini.keyPlaceholder", placeholder: "...",
      href: "https://aistudio.google.com/api-keys", analytics: "gemini_tts" } },
  { id: "fishAudio", section: "voice", labelKey: "keys.label.fishAudio", purposeKey: "keys.purpose.fishAudio", name: "Fish Audio", env: ["LUNABOT_FISH_AUDIO_API_KEY"],
    words: ["fish", "fish audio", "voice", "voices", "speech", "tts"], mark: { icon: AudioLines }, kind: "key",
    target: { patch: (value) => ({ tts: { fishKey: value } }), slot: "fishAudioKey", verifiedOnSave: true,
      saved: (config) => flag(config.savedKeys?.fishAudioKey ?? { configured: config.tts?.provider === "fish" && config.tts.configured }),
      placeholder: "…", placeholderKey: "voice.fish.keyPlaceholder", href: "https://fish.audio/app/api-keys/", analytics: "fish_audio" } },
  { id: "box", section: "computers", labelKey: "keys.boat.label", purposeKey: "keys.purpose.box", name: "boat.dev", env: ["BOX_TOKEN"],
    words: ["boat", "box", "cloud desktop", "cloud computer", "computer", "sandbox"], mark: { icon: Monitor }, kind: "key",
    target: { patch: (value) => ({ box: { token: value } }), slot: "boxToken", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.box?.included ? undefined : config.box), ...(config.box?.included ? { included: true } : {}) }),
      placeholder: "boat_…", href: "https://docs.boat.dev/api-keys", analytics: "boat", shape: /^(boat|box)_/, warningKey: "keys.boat.warning" } },
  { id: "vps", section: "computers", labelKey: "keys.vps.label", purposeKey: "keys.purpose.vps", name: "VPS", env: [],
    words: ["vps", "ssh", "server", "self-hosted", "computer", "docker"], mark: { icon: Server }, kind: "panel",
    status: (config) => ({ configured: config.vps?.configured === true }) },
  { id: "onePassword", section: "computers", labelKey: "settings.logins.onePassword.title", purposeKey: "keys.purpose.onePassword", name: "1Password", env: [],
    words: ["1password", "one password", "logins", "passwords", "vault", "service account"], mark: { icon: LockKeyhole }, kind: "elsewhere",
    opens: "logins", whereKey: "keys.where.vault" },
  { id: "composio", section: "apps", labelKey: "keys.composio.label", purposeKey: "keys.purpose.composio", name: "Composio", env: ["COMPOSIO_API_KEY"],
    words: ["composio", "connected apps", "apps", "gmail", "slack", "github", "notion", "self-host"], mark: { icon: Blocks }, kind: "key",
    target: { patch: (value) => ({ composio: { apiKey: value } }), slot: "composioApiKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag((config.composio?.mode ?? "self-hosted") === "self-hosted" ? config.composio : undefined),
        ...(config.composio?.mode === "managed" ? { included: true } : {}) }),
      placeholder: "ak_…", href: "https://dashboard.composio.dev/~/project/settings/api-keys", analytics: "composio", shape: /^ak_/ } },
  { id: "treg", section: "apps", labelKey: "keys.treg.label", purposeKey: "keys.purpose.treg", name: "treg", env: ["LUNABOT_TREG_KEY"],
    words: ["treg", "research", "x", "twitter", "companies", "people", "funding", "news"], mark: { icon: Search }, kind: "key",
    target: { ...providerKey("treg", { slot: "tregApiKey", placeholder: "…", placeholderKey: "keys.treg.placeholder", href: "https://treg.to", test: "treg", analytics: "treg" }),
      saved: (config) => ({ ...flag(config.treg), ...(config.xResearch?.included && !config.treg?.configured ? { included: true } : {}) }) } },
  { id: "postiz", section: "apps", labelKey: "keys.postiz.label", purposeKey: "keys.purpose.postiz", name: "Postiz", env: ["LUNABOT_POSTIZ_API_KEY"],
    words: ["postiz", "social", "social media", "posts", "schedule", "linkedin", "instagram", "x", "twitter"], mark: { icon: CalendarClock }, kind: "key",
    target: { patch: (value) => ({ postiz: { key: value } }), slot: "postizApiKey", verifiedOnSave: true, saved: (config) => flag(config.postiz),
      placeholder: "…", placeholderKey: "keys.postiz.placeholder", href: "https://platform.postiz.com/settings", analytics: "postiz" } },
  { id: "jev", section: "helpers", labelKey: "decider.key.label", purposeKey: "keys.purpose.jev", name: "Jev", env: ["LUNABOT_JEV_API_KEY"],
    words: ["jev", "typesafe", "decisions", "extraction", "helper", "rooms"], mark: { icon: Zap }, kind: "key",
    target: { patch: (value) => ({ decider: { key: value } }), slot: "jevApiKey", verifiedOnSave: true,
      saved: (config) => ({ ...flag(config.savedKeys?.jevApiKey ?? { configured: config.helpers?.own.jev === true }), ...(config.decider?.included ? { included: true } : {}) }),
      placeholder: "…", placeholderKey: "decider.key.placeholder", href: "https://typesafe.ai", analytics: "jev" } },
  { id: "openrouterHelper", section: "helpers", labelKey: "keys.label.openrouterHelper", purposeKey: "keys.purpose.openrouterHelper", name: "OpenRouter", env: ["LUNABOT_OPENROUTER_DECIDER_KEY"],
    words: ["openrouter", "decisions", "helper"], mark: provider("openai-compat", "openrouter"), kind: "key",
    target: { patch: (value) => ({ decider: { openrouterKey: value } }), slot: "openrouterDeciderKey", verifiedOnSave: true,
      saved: (config) => flag(config.savedKeys?.openrouterDeciderKey ?? { configured: config.helpers?.own.openrouter === true }),
      placeholder: "sk-or-v1-…", href: "https://openrouter.ai/keys", analytics: "openrouter_decider", shape: /^sk-or-/ } },
  { id: "workersAi", section: "helpers", labelKey: "decider.workersAi.title", purposeKey: "keys.purpose.workersAi", name: "Cloudflare", env: ["LUNABOT_WORKERS_AI_TOKEN"],
    words: ["cloudflare", "workers ai", "clef", "clairic", "decisions", "helper"], mark: { icon: Zap }, kind: "elsewhere",
    opens: "decisionModel", whereKey: "keys.where.decisions",
    status: (config) => flag(config.savedKeys?.workersAiToken ?? { configured: config.helpers?.own.workersAi === true }) },
  { id: "imageOpenai", section: "helpers", labelKey: "keys.label.imageOpenai", purposeKey: "keys.purpose.imageOpenai", name: "OpenAI", env: ["LUNABOT_OPENAI_IMAGE_KEY"],
    words: ["openai", "image", "images", "pictures", "avatar", "gpt image"], mark: { icon: Image }, kind: "key",
    target: { patch: (value) => ({ imageGen: { key: value } }), slot: "openaiImageApiKey",
      saved: (config) => flag(config.savedKeys?.openaiImageApiKey ?? { configured: config.imageGen?.openaiConfigured === true }),
      placeholder: "sk-…", href: "https://platform.openai.com/api-keys", analytics: "openai_image", shape: OPENAI_SHAPE } },
  { id: "imageGemini", section: "helpers", labelKey: "keys.label.imageGemini", purposeKey: "keys.purpose.imageGemini", name: "Gemini", env: ["LUNABOT_GEMINI_IMAGE_KEY"],
    words: ["gemini", "google", "nano banana", "image", "images", "pictures"], mark: { icon: Image }, kind: "elsewhere",
    opens: "imageGeneration", whereKey: "keys.where.imageGeneration",
    status: (config) => flag(config.savedKeys?.geminiImageApiKey ?? { configured: config.imageGen?.geminiConfigured === true }) },
  { id: "imageCustom", section: "helpers", labelKey: "keys.label.imageCustom", purposeKey: "keys.purpose.imageCustom", name: "Custom", env: ["LUNABOT_CUSTOM_IMAGE_KEY"],
    words: ["image", "images", "pictures", "avatar", "custom"], mark: { icon: Fingerprint }, kind: "elsewhere",
    opens: "imageGeneration", whereKey: "keys.where.imageGeneration",
    status: (config) => flag(config.savedKeys?.customImageApiKey ?? { configured: config.imageGen?.customKeyConfigured === true }) },
];

export function keyEntry(id: KeyId): KeyEntry {
  const entry = KEY_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no key ${id}`);
  return entry;
}

/** With Azure OpenAI chosen for Live calls, the row for their key is about the Azure resource: required, and no OpenAI key. */
export function shownKeyEntry(id: KeyId, config: ConfigStatus | null | undefined): KeyEntry {
  const entry = keyEntry(id);
  if (id !== "liveKey" || config?.live?.provider !== "azure" || !entry.target) return entry;
  const { shape: _openAiShape, ...target } = entry.target;
  return { ...entry, name: "Azure OpenAI", labelKey: "call.live.azureKeyField", purposeKey: "keys.purpose.liveKeyAzure", target: { ...target, placeholder: "…", href: "https://portal.azure.com" } };
}

export function keySection(entry: KeyEntry) {
  return KEY_SECTIONS.find((section) => section.id === entry.section)!;
}

export function savedState(entry: KeyEntry, config: ConfigStatus | null | undefined): SavedState {
  if (!config) return { configured: false };
  if (entry.uses) return savedState(keyEntry(entry.uses), config);
  return entry.target?.saved(config) ?? entry.status?.(config) ?? { configured: false };
}

export function keyMatches(entry: KeyEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t(entry.labelKey), t(entry.purposeKey), t(keySection(entry).titleKey), entry.name, ...entry.words].some((part) => part.toLowerCase().includes(q));
}

export function looksLikeOtherKey(entry: KeyEntry, value: string): KeyEntry | null {
  const key = value.trim();
  const own = entry.uses ? keyEntry(entry.uses) : entry;
  if (!key || own.target?.shape?.test(key)) return null;
  return KEY_CATALOG.find((other) => other.name !== own.name && other.target?.shape?.test(key)) ?? null;
}

const INSTANCE_KEYS: Readonly<Record<string, KeyId>> = {
  openai: "openai", claudeApi: "anthropic", xaiApi: "xai", grok: "xai", openrouter: "openrouter", mistral: "mistral", cerebras: "cerebras",
  groq: "groq", greenference: "greenference", tk1688: "tk1688", meta: "meta", deepseek: "deepseek", opencodeGo: "opencodeGo", openaiCompat: "openaiCompat",
  pi: "openaiCompat",
};

export function keyForInstance(instanceId: string | undefined): KeyId | undefined {
  return instanceId ? INSTANCE_KEYS[instanceId] : undefined;
}

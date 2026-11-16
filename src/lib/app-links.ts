export const APP_NAME = "Luna Bot";
/** The private source repository, kept for provenance; every link a person can click points at the Cloud instead, so a
 * signed-out visitor never lands on a 404. */
export const APP_REPOSITORY = "https://github.com/liguan-89/dexbot";
export const CLOUD_ORIGIN = "https://cloud.dexai.vip";
export const DOCS_URL = `${CLOUD_ORIGIN}/docs`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${DOCS_URL}#permissions`;
export const PASSKEY_HELP_URL = `${DOCS_URL}#troubleshooting`;
export const FEEDBACK_URL = `${CLOUD_ORIGIN}/feedback`;
export const RELEASES_URL = `${CLOUD_ORIGIN}/download`;
export const PRICING_URL = `${CLOUD_ORIGIN}/pricing`;
export const CLOUD_PLAN_URL = `${CLOUD_ORIGIN}/cloud`;
export function withSource(url: string, source: string): string {
  const target = new URL(url);
  target.searchParams.set("src", source);
  return target.href;
}
export const LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";
export const IOS_APP_STORE_URL = `${CLOUD_ORIGIN}/download`;
export const ANDROID_APK_URL = `${CLOUD_ORIGIN}/download/dexbot.apk`;

export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

export async function openExternalLink(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** A browser hands a mailto: link to its own mail app; the desktop app's window may not navigate to one, so main opens it. */
export async function openEmailDraft(url: string): Promise<void> {
  if (window.ogb) return openExternalLink(url);
  window.location.href = url;
}

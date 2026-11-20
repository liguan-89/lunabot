import { en, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";

const DEFAULT_NAME_KEY: Readonly<Record<string, LocaleKey>> = {
  claudeApi: "engines.defaultName.claudeApi",
  chatgpt: "engines.defaultName.chatgpt",
  openaiCompat: "engines.defaultName.openaiCompat",
};

/** pi is the only engine this build runs, so its internal name is never shown: name the one provider it uses. */
const PI_DRIVER_KIND = "piAgent";
const PI_INSTANCE_ID = "pi";
const PI_NAME = "pi";

export function engineDisplayName(instance: { instanceId: string; displayName: string; driverKind?: string }): string {
  if (instance.displayName === PI_NAME && (instance.driverKind === PI_DRIVER_KIND || instance.instanceId === PI_INSTANCE_ID)) {
    return t("keys.openaiCompat.label");
  }
  const key = Object.hasOwn(DEFAULT_NAME_KEY, instance.instanceId) ? DEFAULT_NAME_KEY[instance.instanceId] : undefined;
  return key && instance.displayName === en[key] ? t(key) : instance.displayName;
}

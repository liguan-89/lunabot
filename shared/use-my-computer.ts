/** The Use my Mac link older bot messages hold; it shows as plain text. */
export const USE_MY_COMPUTER_URL = "lunabot://use-my-computer";
/** The same link as it was written before the rename; messages already sent keep it. */
export const LEGACY_USE_MY_COMPUTER_URL = "dexbot://use-my-computer";

export function isUseMyComputerUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === USE_MY_COMPUTER_URL || normalized === LEGACY_USE_MY_COMPUTER_URL;
}

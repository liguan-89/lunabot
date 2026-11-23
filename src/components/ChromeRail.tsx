import { useEffect } from "react";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { wearSkin } from "@/lib/skins";
import { AccountsSheet, useAccountsSheet } from "./AccountMenu";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { PlacesRail } from "./PlacesRail";

/** The window's own rail of places (main's chrome-rail.mjs): this app's page in a see-through view over the window,
 * up while its places popover or a sheet of its own is open, in the skin and language of the app. */
export function ChromeRail() {
  usePageLanguage(effectiveLanguage(useLanguageChoice(), undefined));
  // The page beside the rail chose its skin: the rail wears the same one.
  useEffect(() => window.ogb?.rail?.onSkin?.(wearSkin), []);
  const accounts = useAccountsSheet();
  return <DesktopCapabilitiesProvider><div data-chrome-rail className="h-full"><PlacesRail /></div>{accounts.open && <AccountsSheet onClose={accounts.close} />}</DesktopCapabilitiesProvider>;
}

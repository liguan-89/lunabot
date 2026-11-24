import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: true, section: "logins" as AppSettingsSection }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section, instances: [], bots: [],
      config: { composio: { mode: "self" } },
      appSettingsCloudLink: 0, appSettingsPhonePairing: 0, routineRuns: [],
    },
    dispatch: vi.fn(), refreshInstances: vi.fn(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }), useCaptionChrome: () => ({ dragProps: {} }) }));
vi.mock("./SidebarProfileMenu", async (importOriginal) => ({ ...await importOriginal<typeof import("./SidebarProfileMenu")>(), useServerUpdateItem: () => null }));
vi.mock("./VaultSettings", () => ({ VaultSettings: () => "VAULT MARKER" }));
vi.mock("./PaymentCardsSettings", () => ({ PaymentCardsSettings: () => "CARDS MARKER" }));
vi.mock("./ChannelsSettings", () => ({ ChannelsSettings: () => "CHANNELS MARKER" }));
// Simple's Computer page talks to the host as it mounts; this test is about the logins block only.
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: () => null }));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("./PhoneDevicesSection", () => ({ PhoneDevicesSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: () => null }));

const { SettingsModal } = await import("./SettingsModal");

const render = () => renderToStaticMarkup(createElement(SettingsModal));

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("window", { ogb: {} });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.unstubAllGlobals(); setLocale("en"); });

describe("Logins and message channels", () => {
  it.each([true, false])("draws the vault, the cards and the channels in both modes (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    const html = render();
    for (const marker of ["VAULT MARKER", "CARDS MARKER"]) expect(html, marker).toContain(marker);
    if (advanced) {
      // Advanced files channels under its own page, next to the vault.
      fixture.section = "channels";
      expect(render(), "CHANNELS MARKER").toContain("CHANNELS MARKER");
      fixture.section = "logins";
    } else {
      expect(html, "CHANNELS MARKER").toContain("CHANNELS MARKER");
    }
  });
});

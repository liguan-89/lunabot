import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import { rowSearchResults, SECTIONS } from "./registry";
import { SETTINGS_ROWS } from "./rows";

const fixture = vi.hoisted(() => ({ advanced: true, section: "general" as AppSettingsSection }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section, instances: [], bots: [],
      config: { features: { browser: true, showToolCalls: true }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" }, rooms: { turnTimeoutMinutes: 5 }, profile: { name: "L", email: "l@x" } },
      appSettingsCloudLink: 0, appSettingsPhonePairing: 0, routineRuns: [],
    },
    dispatch: vi.fn(),
    refreshInstances: vi.fn(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }), useCaptionChrome: () => ({ dragProps: {} }) }));
vi.mock("@/components/SidebarProfileMenu", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/SidebarProfileMenu")>(), useServerUpdateItem: () => null }));
// The machine sections talk to the host on mount; the rows this test looks at sit above them.
vi.mock("@/components/LocalComputerSection", () => ({ LocalComputerSection: () => null }));
vi.mock("@/components/RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("@/components/PhoneDevicesSection", () => ({ PhoneDevicesSection: () => null }));
vi.mock("@/components/ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("@/components/CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));

const { SettingsModal } = await import("@/components/SettingsModal");

const rendered = (section: AppSettingsSection, advanced: boolean): string => {
  fixture.section = section;
  fixture.advanced = advanced;
  return renderToStaticMarkup(createElement(SettingsModal));
};

/** The `data-settings-row` values in the markup, which is what a search result scrolls to. */
const anchors = (html: string): string[] => [...html.matchAll(/data-settings-row="([^"]*)"/g)].map((match) => match[1]!.replace(/&#x27;|&quot;|&amp;/g, (entity) => ({ "&#x27;": "'", "&quot;": '"', "&amp;": "&" })[entity]!));

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("window", { ogb: { environments: {}, organization: {}, cloudAccount: {}, market: {} } });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("SETTINGS_ROWS", () => {
  it("names each row once", () => {
    const ids = SETTINGS_ROWS.map((entry) => entry.titleKeys[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every entry at a row the page actually draws", () => {
    const drawn = new Map<AppSettingsSection, Set<string>>();
    for (const entry of SETTINGS_ROWS) {
      if (!drawn.has(entry.section)) drawn.set(entry.section, new Set(anchors(rendered(entry.section, true))));
    }
    const missing: string[] = [];
    for (const entry of SETTINGS_ROWS.filter((candidate) => !candidate.lazy)) {
      const titles = entry.titleKeys.map((key) => t(key));
      const found = drawn.get(entry.section)!;
      if (!titles.some((title) => found.has(title))) missing.push(`${entry.titleKeys[0]} → ${entry.section}`);
    }
    expect(missing).toEqual([]);
  });

  it("finds the Simple wording too, for a row whose two modes word it differently", () => {
    expect(anchors(rendered("general", false))).toContain("Light or dark");
    expect(anchors(rendered("appearance", true))).toContain("Theme");
  });

  it("is found by its own title in every language the row is drawn in", () => {
    const missed: string[] = [];
    for (const locale of ["en", "zh", "ja", "ko", "ru", "fr", "de", "es", "pt-br"] as const) {
      setLocale(locale);
      for (const entry of SETTINGS_ROWS) {
        const title = t(entry.titleKeys[0]).toLowerCase();
        const hits = rowSearchResults(title, new Set(SECTIONS.map((section) => section.id)));
        if (!hits.some((hit) => hit.titleKeys[0] === entry.titleKeys[0])) missed.push(`${locale} ${entry.titleKeys[0]}: "${title}"`);
      }
    }
    setLocale("en");
    expect(missed).toEqual([]);
  });
});

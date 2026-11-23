// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), section: "general" }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: {
      appSettingsSection: fixture.section, instances: [], bots: [],
      config: { features: { browser: true, showToolCalls: true }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" }, rooms: { turnTimeoutMinutes: 5 } },
      appSettingsCloudLink: 0, appSettingsPhonePairing: 0, routineRuns: [],
    },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: {} } }), useCaptionChrome: () => ({ dragProps: {} }) }));
vi.mock("./SidebarProfileMenu", async (importOriginal) => ({ ...await importOriginal<typeof import("./SidebarProfileMenu")>(), useServerUpdateItem: () => null }));
for (const [path, name] of [
  ["./EnginesSettings", "EnginesSettings"], ["./RemoteComputerSection", "RemoteComputerSection"], ["./PhoneDevicesSection", "PhoneDevicesSection"],
  ["./ServerPairingCard", "ServerPairingCard"], ["./LocalComputerSection", "LocalComputerSection"], ["./CloudAccountSettings", "CloudAccountSettings"],
  ["./PeopleSection", "PeopleSection"], ["./ActivitySection", "ActivitySection"], ["./UsageSection", "UsageSection"], ["./ImportSettings", "ImportSettings"],
  ["./CustomDomainSettings", "CustomDomainSettings"], ["./VaultSettings", "VaultSettings"], ["./PlanUsage", "PlanUsageSummary"],
] as const) vi.doMock(path, async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), [name]: () => null }));

const { SettingsModal } = await import("./SettingsModal");
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(SettingsModal)));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const searchFields = () => [...document.querySelectorAll<HTMLInputElement>("[data-settings-search]")];
const type = (value: string) => {
  const field = searchFields().at(-1)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};

describe("Settings search on a narrow window", () => {
  it("offers a search field outside the rail, which is hidden below sm", () => {
    const fields = searchFields();
    expect(fields).toHaveLength(2);
    const inRail = fields.filter((field) => field.closest("nav"));
    expect(inRail).toHaveLength(1);
    const header = fields.find((field) => !field.closest("nav"))!;
    expect(header.closest("header")).not.toBeNull();
    expect(header.parentElement!.parentElement!.className).toContain("sm:hidden");
  });

  it("shows the results in place of the page while a query is typed, and puts the page back when it is cleared", () => {
    const page = () => document.querySelector<HTMLElement>("[data-settings-scroll]")!;
    expect(page().className).not.toContain("hidden");
    type("notification sounds");
    expect(page().className).toContain("hidden");
    const panel = document.querySelector<HTMLElement>("[data-settings-sheet] [data-settings-row-result]")!;
    expect(panel.textContent).toContain("Notification sounds");
    type("");
    expect(page().className).not.toContain("hidden");
  });
});

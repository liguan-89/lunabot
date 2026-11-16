// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), scrolled: [] as Element[], section: "general" }));
vi.mock("@/lib/scroll-within", () => ({ scrollWithin: (_scroller: unknown, target: Element) => { fixture.scrolled.push(target); }, scrollParent: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { appSettingsSection: fixture.section, instances: [], bots: [], config: { features: {}, composio: { mode: "self" }, rooms: { turnTimeoutMinutes: 5 } }, appSettingsCloudLink: 0, appSettingsPhonePairing: 0 },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: {} } }) }));
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
const scrolled = fixture.scrolled;

beforeAll(() => {
  HTMLElement.prototype.checkVisibility ??= () => true;
});

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.section = "general";
  setLocale("en");
  scrolled.length = 0;
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

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const search = () => document.querySelector<HTMLInputElement>("[data-settings-search]")!;
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
  flushSync(() => search().dispatchEvent(new Event("input", { bubbles: true })));
};

describe("Settings search in Simple mode", () => {
  it("opens on the dialog itself, and a typed letter moves into search", () => {
    expect(document.activeElement).toBe(dialog());
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(search());
    expect(search().value).toBe("f");
  });

  it("lists a builder control as More looks and, when chosen, opens General with that fold open", () => {
    type("font");
    const result = document.querySelector<HTMLButtonElement>('[data-settings-advanced-only="settings.font.title"]')!;
    expect(result.textContent).toBe("Interface font · More looks");
    flushSync(() => result.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "general" });
    expect(document.querySelector("h2")!.textContent).toBe("General");
    expect(document.querySelector<HTMLElement>('[data-settings-block="looks"]')!.querySelector("[hidden]")).toBeNull();
    expect(search().value).toBe("");
  });

  it("finds every other builder control as More looks, and Automatic recovery on the Limits and backups page", () => {
    for (const [words, key] of [["chat width", "settings.chatWidth.title"], ["circles", "settings.pinnedCircles.title"],
      ["universal", "settings.universalPins.title"], ["this run", "settings.runCard.title"]]) {
      type(words);
      expect(document.querySelector(`[data-settings-advanced-only="${key}"]`)?.textContent, words).toMatch(/ · More looks$/);
    }
    type("recovery");
    expect(document.querySelector("[data-settings-advanced-only]")).toBeNull();
    const result = document.querySelector<HTMLButtonElement>('[data-settings-more-result="settings.recovery.title"]')!;
    expect(result.textContent).toBe("Automatic recovery · Limits");
    flushSync(() => result.click());
    // The store owns the open section; the test stands in for the dispatch it would have handled.
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
    fixture.section = "backups";
    flushSync(() => root.render(createElement(SettingsModal)));
    expect(document.querySelector("h2")!.textContent).toBe("Limits and backups");
    expect(document.querySelector('[data-settings-block="limits"]')!.textContent).toContain("Automatic recovery");
    expect(search().value).toBe("");
  });

  it("opens the Limits and backups page from the rail, with Limits above the backups", () => {
    flushSync(() => document.querySelector<HTMLButtonElement>('[data-settings-page="advanced"]')!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
    fixture.section = "backups";
    flushSync(() => root.render(createElement(SettingsModal)));
    expect(document.querySelector("h2")!.textContent).toBe("Limits and backups");
    const limits = document.querySelector('[data-settings-block="limits"]')!;
    expect(limits.querySelector("h3")!.textContent).toBe("Limits");
    for (const title of ["Group turns", "Tool time limit", "Parallel threads", "Automatic recovery", "Event log cleanup"]) expect(limits.textContent, title).toContain(title);
    expect(document.querySelector('[data-settings-block="backups"]')).not.toBeNull();
  });

  it("finds a limit and opens the Limits and backups page at its row", () => {
    type("parallel");
    const limit = document.querySelector<HTMLButtonElement>('[data-settings-more-result="settings.threads.title"]')!;
    expect(limit.textContent).toBe("Parallel threads · Limits");
    expect(document.querySelector('[data-settings-advanced-only="settings.threads.title"]')).toBeNull();
    flushSync(() => limit.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "backups" });
    fixture.section = "backups";
    flushSync(() => root.render(createElement(SettingsModal)));
    expect(document.querySelector("h2")!.textContent).toBe("Limits and backups");
    expect(document.querySelector('[data-settings-block="limits"]')!.textContent).toContain("Parallel threads");
  });

  it("finds a row on the page it is drawn on and scrolls to the row itself", () => {
    type("notification sounds");
    const result = document.querySelector<HTMLButtonElement>('[data-settings-row-result="settings.notificationSounds.title"]')!;
    expect(result.textContent).toBe("Notification sounds · Appearance");
    flushSync(() => result.click());
    // Simple files Appearance on General, so that is the page that opens; the scroll goes to the row, not the page top.
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "general" });
    expect(search().value).toBe("");
    expect(scrolled.map((element) => element.getAttribute("data-settings-row"))).toContain("Notification sounds");
  });

  it("finds a row by two words that are nowhere together in one label", () => {
    type("show threads");
    expect(document.querySelector('[data-settings-advanced-only="settings.threadDisplay.title"]')?.textContent).toBe("Threads · More looks");
    type("send key");
    expect(document.querySelector('[data-settings-row-result="settings.sendKey.title"]')?.textContent).toBe("Send messages with · Appearance");
  });
});

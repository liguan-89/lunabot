import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { SECTIONS, SIMPLE_FOLDED, SIMPLE_PAGES, SettingsModal, revealSettingsBlock } from "./SettingsModal";
import { SETTINGS_ROWS } from "./settings/rows";

const fixture = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  advancedMode: false,
  config: { features: { browser: false }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" } } as Record<string, unknown>,
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
  ownerOrAdmin: null as boolean | null,
  updater: null as import("@/lib/updater").UpdaterState | null,
  serverUpdate: null as ReturnType<typeof import("./SidebarProfileMenu").useServerUpdateItem>,
  rail: null as { available: boolean; hidden: boolean } | null,
  railHidden: [] as boolean[],
}));

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], bots: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/chrome-rail", () => ({ useChromeRail: () => fixture.rail, setChromeRailHidden: (hidden: boolean) => fixture.railHidden.push(hidden) }));
vi.mock("./SettingsPrimitives", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return {
    ...original,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.switches.push(props);
      return createElement(original.Switch, props);
    },
  };
});
// Each page's own content has its own tests; here a marker says which ran.
const { marker } = vi.hoisted(() => ({
  marker: (name: string) => () => `MARKER:${name};`,
}));
vi.mock("./EnginesSettings", () => ({ EnginesSettings: marker("engines"), EngineMaintenance: marker("maintenance") }));
vi.mock("./ModelManagement", () => ({ ModelManagement: marker("models") }));
vi.mock("./DecisionModelSettings", () => ({ DecisionModelSettings: marker("decisionModel") }));
vi.mock("./ImageGenerationSettings", () => ({ ImageGenerationSettings: marker("imageGeneration") }));
vi.mock("./SkillsSection", () => ({ SkillsSection: marker("skills") }));
vi.mock("./keys/KeysPage", () => ({ KeysPage: marker("apiKey") }));
vi.mock("./RemoteComputerSection", () => ({ RemoteComputerSection: marker("companion") }));
vi.mock("./CustomDomainSettings", () => ({ CustomDomainSettings: () => null }));
vi.mock("./PhoneDevicesSection", () => ({ PhoneDevicesSection: () => null }));
vi.mock("./ServerPairingCard", () => ({ ServerPairingCard: () => null }));
vi.mock("./ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: marker("desktopWorkspaces") }));
vi.mock("./LocalComputerSection", () => ({ LocalComputerSection: marker("computer") }));
vi.mock("./CloudAccountSettings", () => ({ CloudAccountSettings: marker("cloudAccount") }));
vi.mock("./OrganizationSettings", () => ({ OrganizationSettings: marker("organization") }));
vi.mock("./PeopleSection", () => ({ PeopleSection: marker("people") }));
vi.mock("./ActivitySection", () => ({ ActivitySection: marker("activity") }));
vi.mock("./UsageSection", () => ({ UsageSection: marker("usage") }));
vi.mock("./WorkspaceBackupSettings", () => ({ WorkspaceBackupSettings: marker("backups") }));
vi.mock("./RoomTurnTimeoutSettings", () => ({ RoomTurnTimeoutSettings: () => null }));
vi.mock("./CompanyBackupSettings", () => ({ CompanyBackupSettings: () => null }));
vi.mock("./ImportSettings", () => ({ ImportSettings: marker("import") }));
vi.mock("./UpdatesConsent", async (importOriginal) => ({
  ...await importOriginal<typeof import("./UpdatesConsent")>(),
  UpdatesConsentRow: marker("updatesConsent"),
}));
vi.mock("./SidebarProfileMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarProfileMenu")>(),
  useServerUpdateItem: () => fixture.serverUpdate,
}));
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/updater")>(),
  useUpdaterState: () => fixture.updater,
}));

const desktop = { ogb: { environments: {}, organization: {}, cloudAccount: {}, companion: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "general";
  fixture.advancedMode = false;
  fixture.config = { features: { browser: false }, browserEngine: { kind: "bundled", installable: true }, composio: { mode: "self" } };
  fixture.switches = [];
  fixture.ownerOrAdmin = null;
  fixture.updater = null;
  fixture.serverUpdate = null;
  fixture.rail = null;
  fixture.railHidden = [];
  fixture.api.mockResolvedValue({});
  vi.stubGlobal("window", desktop);
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = () => renderToStaticMarkup(createElement(SettingsModal));
const pages = (html: string) => [...html.matchAll(/data-settings-page="([^"]+)"/g)].map((match) => match[1]);
const currentPage = (html: string) => html.match(/data-settings-page="([^"]+)" aria-current="page"/)?.[1];
const blocks = (html: string) => [...html.matchAll(/data-settings-block="([^"]+)"/g)].map((match) => match[1]);
const markers = (html: string) => [...html.matchAll(/MARKER:([^;]+);/g)].map((match) => match[1]);
const groupLabels = (html: string) => [...html.matchAll(/<h3 id="[^"]*" class="[^"]*">([^<]+)<\/h3>/g)].map((match) => match[1]);

/** Where each folded region (`hidden`) starts and ends in the markup. */
function foldedRanges(html: string): Array<[number, number]> {
  return [...html.matchAll(/<div[^>]*\bhidden=""[^>]*>/g)].map((open) => {
    const tags = /<\/?div\b[^>]*>/g;
    tags.lastIndex = open.index! + open[0].length;
    let depth = 1;
    for (let tag = tags.exec(html); tag && depth > 0; tag = depth > 0 ? tags.exec(html) : null) depth += tag[0].startsWith("</") ? -1 : 1;
    return [open.index!, tags.lastIndex];
  });
}
const placement = (html: string, needle: string): "shown" | "folded" | "missing" => {
  const at = html.indexOf(needle);
  if (at < 0) return "missing";
  return foldedRanges(html).some(([from, to]) => at > from && at < to) ? "folded" : "shown";
};
const open = (section: AppSettingsSection) => { fixture.section = section; return render(); };

describe("Settings in Simple mode", () => {
  it("draws every page on the desktop, and no Advanced rail", () => {
    const html = render();
    expect(pages(html)).toEqual(["general", "team", "ai", "computer", "billing", "advanced", "updates"]);
    expect(SIMPLE_PAGES.map((page) => page.id)).toEqual(["general", "team", "ai", "computer", "billing", "advanced", "updates"]);
    expect(html).toMatch(/General<\/span>[\s\S]*Team<\/span>[\s\S]*AI<\/span>[\s\S]*Computer<\/span>[\s\S]*Usage &amp; billing<\/span>[\s\S]*Limits and backups<\/span>[\s\S]*Updates<\/span>/);
    expect(html).not.toContain("data-settings-group=");
    expect(html).not.toContain("data-settings-section=");
    expect(html).not.toMatch(/class="(?:[^"]*\s)?uppercase(?:\s[^"]*)?"/);
    const picker = html.match(/<select aria-label="Settings"[\s\S]*?<\/select>/)![0];
    expect([...picker.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(["general", "team", "ai", "computer", "billing", "advanced", "updates"]);
    expect(html).toContain('data-settings-look="simple"');
  });

  it("gives a team's admins Bot access as a block of Team, and nobody else", () => {
    vi.stubGlobal("window", {});
    fixture.config = { ...fixture.config, team: { id: "team-acme", name: "Acme" }, cloudHome: true };
    fixture.ownerOrAdmin = true;
    expect(pages(render())).toContain("team");
    expect(blocks(render())).not.toContain("botAccess");
    fixture.section = "botAccess";
    expect(currentPage(render())).toBe("team");
    expect(blocks(render())).toContain("botAccess");
    fixture.ownerOrAdmin = false;
    expect(pages(render())).not.toContain("botAccess");
    expect(blocks(render())).not.toContain("botAccess");
  });

  it("files every Advanced page under one Simple page", () => {
    const placed = SIMPLE_PAGES.flatMap((page) => page.sections);
    expect(new Set(placed).size).toBe(placed.length);
    expect(SECTIONS.map((entry) => entry.id).filter((id) => !placed.includes(id))).toEqual([]);
  });

  it("opens General on Account, then Appearance, Language and typing, Notifications and System, with Advanced mode last as a plain row", () => {
    const html = render();
    expect(currentPage(html)).toBe("general");
    expect(groupLabels(html)).toEqual(["Account", "Appearance", "Language and typing", "Notifications", "System", "Import"]);
    expect(blocks(html).slice(-1)).toEqual(["advanced-mode"]);
    expect(html).not.toContain(">More settings<");
    expect([...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].at(-1)?.[0]).toContain('aria-label="Advanced mode"');
    expect(html).toContain("Show every control, including tools for builders. Nothing is deleted either way.");
    expect(html).not.toContain("border-accent-border/40");
    expect(html).toContain(">Your name</div>");
    expect(html).toContain(">Not set yet</div>");
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*>Add<\/button>/);
  });

  it("puts the sidebar's colour and picture under Theme in General, the switch for the window's rail beside them, and the skins and builder rows in one folded More looks", () => {
    fixture.rail = { available: true, hidden: false };
    const html = render();
    const appearance = html.slice(html.indexOf('data-settings-block="appearance"'), html.indexOf(">Notifications<"));
    const order = ['role="radiogroup" aria-label="Light or dark"', ">Sidebar picture<", 'aria-label="Show your computers"', 'aria-label="Color my messages with the bot&#x27;s color"', ">More looks<"]
      .map((needle) => appearance.indexOf(needle));
    expect(order.every((at) => at > -1), String(order)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(appearance).toContain("An icon for each place your bots live");
    const toggle = fixture.switches.find((props) => props["aria-label"] === "Show your computers")!;
    expect(toggle.checked).toBe(true);
    toggle.onClick!({} as never);
    expect(fixture.railHidden).toEqual([true]);
    // Folded until asked for, holding the skins and every builder row.
    expect(placement(html, 'aria-label="Show tool calls in chat"')).toBe("folded");
    const looks = html.slice(html.indexOf('data-settings-block="looks"'));
    for (const label of ["Show tool calls in chat", "Interface font", "Chat width", "Show threads", "Pinned bots as circles", "Universal pins", "Choose tools layout", "Show the run card"]) {
      expect(looks, label).toContain(label);
    }
  });

  it("shows the rail's switch only where this window has a rail to hide", () => {
    for (const rail of [null, { available: false, hidden: true }]) {
      fixture.rail = rail;
      expect(render()).not.toContain("Show your computers");
    }
    fixture.rail = { available: true, hidden: true };
    render();
    expect(fixture.switches.find((props) => props["aria-label"] === "Show your computers")?.checked).toBe(false);
  });

  it("keeps the everyday rows on General, moves the limits to the Limits and backups page, and keeps the builder controls behind More looks", () => {
    const general = open("general");
    for (const shown of ['aria-label="Send usage analytics"', 'aria-label="Color my messages with the bot&#x27;s color"', 'aria-label="Send messages with"',
      'aria-label="Notification sounds"', 'aria-label="Show the notification feed"', 'aria-label="App language"', 'role="radiogroup" aria-label="Light or dark"']) {
      expect(placement(general, shown), shown).toBe("shown");
    }
    expect(placement(open("updates"), "MARKER:updatesConsent;")).toBe("shown");
    const everyPage = ["general", "engines", "companion", "usage", "updates"].map((section) => open(section as AppSettingsSection)).join("");
    for (const gone of ["Group turns", "Tool time limit", "Parallel threads", "Automatic recovery", "Event log cleanup", "Keep prompt cache warm"]) {
      expect(everyPage, gone).not.toContain(`>${gone}<`);
    }
    // The builder rows live inside General's folded More looks, so they are present but not on show until it is opened.
    for (const folded of ["Interface font", "Chat width", "Pinned bots as circles", "Universal pins", "Show tool calls in chat", "This run"]) {
      expect(placement(open("general"), folded), folded).toBe("folded");
    }
    expect(SETTINGS_ROWS.filter((entry) => entry.simpleLooks).map((entry) => t(entry.titleKeys[0])))
      .toEqual(["Pinned panels", "Interface font", "Chat width", "Threads", "Pinned bots as circles", "Universal pins", "Tools layout", "This run"]);
    expect(SETTINGS_ROWS.filter((entry) => entry.simpleMore).map((entry) => t(entry.titleKeys[0])))
      .toEqual(["Group turns", "Tool time limit", "Parallel threads", "Automatic recovery", "Event log cleanup", "Repeat computer tasks without AI", "Check what a bot says it did on your phone"]);
  });

  it("holds the defaults for new bots on AI as one row: the effort they start with, sharing them as a preset, and Edit for the rest", () => {
    const html = open("engines");
    const row = html.slice(html.indexOf(">Defaults for new bots<"));
    expect(row).toContain(">Effort for new bots<");
    expect(row).toMatch(/<select[^>]*aria-label="Effort for new bots"/);
    expect(row).toMatch(/data-new-bot-share="true"[^>]*>Share as preset…<\/button>/);
    expect(row).toMatch(/data-new-bot-defaults="true"[^>]*>Edit<\/button>/);
    expect(html.indexOf("MARKER:engines;")).toBeLessThan(html.indexOf(">Defaults for new bots<"));
    expect(html.indexOf(">Defaults for new bots<")).toBeLessThan(html.indexOf(">API keys<"));
    fixture.ownerOrAdmin = false;
    expect(open("engines")).not.toContain("Defaults for new bots");
  });

  it("names this app and its version on Updates, then product updates, the welcome tour and diagnostics", () => {
    vi.stubGlobal("window", { ogb: { ...desktop.ogb, updater: { check: vi.fn(), install: vi.fn(), onState: vi.fn() } } });
    fixture.updater = { status: "idle" };
    const html = open("updates");
    expect(html).toMatch(/>Luna Bot [^<]+<\/div>/);
    for (const shown of ["Check for updates", "MARKER:updatesConsent;", "Replay welcome tour", "Diagnostics"]) expect(placement(html, shown), shown).toBe("shown");
  });

  it("checks the server's version from a browser", () => {
    vi.stubGlobal("window", {});
    const onSelect = vi.fn();
    fixture.serverUpdate = { phase: "up-to-date", pending: false, label: "Up to date", item: { key: "update", label: "Up to date", subtitle: "v1.2.3", icon: null, disabled: false, onSelect } };
    const html = open("updates");
    expect(html).toMatch(/>Luna Bot [^<]+<\/div>/);
    expect(html).toContain("Up to date v1.2.3");
    expect(placement(html, "Check for updates")).toBe("shown");
  });

  it("opens the fold that holds a linked setting: API keys, image generation, decision, Servers or this app as a client", () => {
    expect(placement(open("connections"), "MARKER:apiKey;")).toBe("shown");
    expect(placement(open("engines"), "MARKER:apiKey;")).toBe("folded");
    expect(placement(open("imageGeneration"), "MARKER:imageGeneration;")).toBe("shown");
    expect(placement(open("engines"), "MARKER:imageGeneration;")).toBe("folded");
    expect(placement(open("decisionModel"), "MARKER:decisionModel;")).toBe("shown");
    expect(placement(open("engines"), "MARKER:decisionModel;")).toBe("folded");
    expect(placement(open("desktopWorkspaces"), "MARKER:desktopWorkspaces;")).toBe("shown");
    expect(placement(open("remote"), "MARKER:companion;")).toBe("shown");
    expect(placement(open("companion"), "MARKER:companion;")).toBe("folded");
    expect(SIMPLE_FOLDED).toEqual({
      connections: "ai-keys", decisionModel: "ai-decision", imageGeneration: "ai-images",
      remote: "computer-elsewhere", desktopWorkspaces: "computer-elsewhere",
    });
  });

  it("shows the AI page as Your AI, then API keys, image generation and decision", () => {
    fixture.section = "engines";
    const html = render();
    expect(currentPage(html)).toBe("ai");
    expect(blocks(html)).toEqual(["engines", "connections", "imageGeneration", "decisionModel"]);
    expect(markers(html).filter((name) => name === "models" || name === "decisionModel")).toEqual(["models", "decisionModel"]);
    expect(html).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?>API keys</);
    expect(html).not.toContain("API keys and connections");
  });

  it("orders Computer as your bots' computers, Phone & devices, the browser, logins, then Connect from elsewhere", () => {
    fixture.section = "companion";
    const html = render();
    expect(currentPage(html)).toBe("computer");
    expect(blocks(html)).toEqual(["computer", "companion", "browser", "logins", "elsewhere", "desktopWorkspaces", "remote"]);
    expect(groupLabels(html)).toEqual(["Your bots’ computers", "Phone &amp; devices", "Built-in browser"].map((label) => label.replace("’", "&#x27;")));
    expect(html).toContain('aria-label="Enable the built-in browser"');
  });

  it("leads Usage & billing with one usage block, folds the limits, then shows the plan", () => {
    fixture.section = "cloudAccount";
    const html = render();
    expect(currentPage(html)).toBe("billing");
    expect(blocks(html)).toEqual(["usage", "cloudAccount"]);
    expect(html.indexOf("See all limits")).toBeLessThan(html.indexOf("MARKER:cloudAccount;"));
    expect(placement(html, "MARKER:usage;")).toBe("folded");
    expect(groupLabels(html)).toContain("Plan");
  });

  it("shows a hosted workspace's admins People and Activity on Team", () => {
    vi.stubGlobal("window", {});
    fixture.ownerOrAdmin = true;
    fixture.section = "people";
    const html = render();
    expect(pages(html)).toEqual(["general", "team", "ai", "computer", "billing", "advanced", "updates"]);
    expect(currentPage(html)).toBe("team");
    expect(placement(html, "MARKER:people;")).toBe("shown");
    expect(placement(html, "MARKER:activity;")).toBe("shown");
    expect(groupLabels(html)).toContain("Activity");
  });

  it("keeps a paired remote client's reduced set: General for appearance, and Computer with your devices and Connect from elsewhere", () => {
    vi.stubGlobal("window", { ogb: { ...desktop.ogb, remoteClient: { active: true } } });
    fixture.section = "desktopWorkspaces";
    const html = render();
    expect(pages(html)).toEqual(["general", "computer"]);
    expect(currentPage(html)).toBe("computer");
    expect(blocks(html)).toEqual(["companion", "elsewhere", "desktopWorkspaces", "remote"]);
    expect(html).not.toContain('aria-label="Enable the built-in browser"');
    fixture.section = "appearance";
    const general = render();
    expect(currentPage(general)).toBe("general");
    expect(general).not.toContain(">Your name</div>");
    expect(general).toContain('aria-label="App language"');
    expect(general).toContain('aria-label="Advanced mode"');
  });

  it.each<[AppSettingsSection, string]>([
    ["general", "general"],
    ["appearance", "general"],
    ["import", "general"],
    ["organization", "team"],
    ["engines", "ai"],
    ["connections", "ai"],
    ["companion", "computer"],
    ["remote", "computer"],
    ["desktopWorkspaces", "computer"],
    ["computer", "computer"],
    ["logins", "computer"],
    ["usage", "billing"],
    ["cloudAccount", "billing"],
    ["updates", "updates"],
  ])("lands a deep link to %s on %s", (section, page) => {
    fixture.section = section;
    const html = render();
    expect(currentPage(html)).toBe(page);
    expect(blocks(html)).toContain(section === "remote" ? "remote" : section);
  });

  it.each<[AppSettingsSection]>([["people"], ["activity"]])("lands a browser's deep link to %s on Team", (section) => {
    // People and Activity are the browser's own pages: a desktop has its own rail for them.
    vi.stubGlobal("window", {});
    fixture.ownerOrAdmin = true;
    fixture.section = section;
    const html = render();
    expect(currentPage(html)).toBe("team");
    expect(blocks(html)).toContain(section);
  });

  it.each<[AppSettingsSection, string, string]>([
    ["backups", "backups", "Limits and backups"],
    ["experimental", "skillAuthoring", "Limits and backups"],
    // The add-a-key suggestion's Add key opens it straight away.
    ["decisionModel", "decisionModel", "AI"],
    ["skills", "skills", "AI"],
  ])("opens %s on the %s page", (section, content, page) => {
    if (section === "skills") fixture.config = { ...fixture.config, features: { ...(fixture.config.features as object), skillsLibrary: true } };
    fixture.section = section;
    const html = render();
    expect(currentPage(html)).toBe(page === "AI" ? "ai" : "advanced");
    expect(blocks(html)).toContain(section);
    if (content === "skillAuthoring") expect(html).toContain("Bots may write their own skills");
    else expect(markers(html)).toContain(content);
  });

  it("scrolls a later section of a stacked page to the top of the scroller alone, and starts a page at its top", () => {
    const block = { getBoundingClientRect: () => ({ top: 500 }) };
    const querySelector = vi.fn(() => block);
    const scroller = { scrollTop: 320, clientHeight: 600, getBoundingClientRect: () => ({ top: 100 }), querySelector };
    revealSettingsBlock(scroller, "connections", 1);
    expect(querySelector).toHaveBeenCalledWith('[data-settings-block="connections"]');
    expect(scroller.scrollTop).toBe(720);
    revealSettingsBlock(scroller, "engines", 0);
    expect(scroller.scrollTop).toBe(0);
    expect(querySelector).toHaveBeenCalledTimes(1);
  });
});

describe("Settings in Advanced mode", () => {
  beforeEach(() => { fixture.advancedMode = true; });

  it("keeps the grouped rail and General, Advanced mode switch first, on the same Settings look as Simple", () => {
    const html = render();
    expect(html).toContain("glass-surface");
    expect(html).toContain('data-settings-look="advanced"');
    expect(html).not.toContain("data-settings-page=");
    expect([...html.matchAll(/data-settings-group="([^"]+)"/g)].map((match) => match[1])).toEqual(["you", "ai", "computers", "account"]);
    expect(html.indexOf('aria-label="Advanced mode"')).toBeLessThan(html.indexOf("Language"));
    expect(html).toContain("Show every technical control on this device");
    expect(html).not.toContain("More settings");
    // The effort for new bots is one row now: Defaults for new bots carries the same select.
    for (const kept of ["Group turns", ">Defaults for new bots<", 'aria-label="Send usage analytics"', "Diagnostics"]) {
      expect(placement(html, kept), kept).toBe("shown");
    }
  });

  it("treats a link to Updates as General", () => {
    fixture.section = "updates";
    const html = render();
    expect(html).toContain('data-settings-section="general" aria-current="page"');
  });
});

describe("the built-in browser switch", () => {
  const browserSwitch = () => fixture.switches.find((props) => props["aria-label"] === "Enable the built-in browser");

  it.each([false, true])("writes features.browser from Devices (advanced: %s)", async (advanced) => {
    fixture.advancedMode = advanced;
    fixture.section = "computer";
    const html = render();
    if (advanced) {
      expect(html.indexOf('aria-label="Enable the built-in browser"')).toBeLessThan(html.indexOf("MARKER:computer;"));
    } else {
      expect(html.indexOf("MARKER:computer;")).toBeLessThan(html.indexOf('aria-label="Enable the built-in browser"'));
    }
    const toggle = browserSwitch()!;
    expect(toggle.checked).toBe(false);
    toggle.onClick!({} as never);
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: {} }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("is no longer on Experimental, which keeps skill drafting", () => {
    fixture.advancedMode = true;
    fixture.section = "experimental";
    const html = render();
    expect(html).not.toContain('aria-label="Enable the built-in browser"');
    expect(html).toContain("Bots may write their own skills");
    expect(browserSwitch()).toBeUndefined();
  });

  it("is found by searching for the browser under Bot desktops in Advanced", () => {
    const computer = SECTIONS.find((entry) => entry.id === "computer")!;
    const experimental = SECTIONS.find((entry) => entry.id === "experimental")!;
    expect(computer.keywords).toContain("browser");
    expect(experimental.keywords).not.toContain("browser");
  });
});

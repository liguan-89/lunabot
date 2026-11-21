import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { AppSettingsSection } from "@/state/store";
import type { Switch } from "./SettingsPrimitives";
import { ADVANCED_PAGES, SECTIONS, SETTINGS_GROUPS, SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  section: "appearance" as AppSettingsSection,
  showThreads: true,
  setShowThreads: vi.fn(),
  showRunCard: true,
  setShowRunCard: vi.fn(),
  notificationSounds: true,
  setNotificationSounds: vi.fn(),
  advancedMode: false,
  setAdvancedMode: vi.fn(),
  api: vi.fn(),
  dispatch: vi.fn(),
  switches: [] as ComponentProps<typeof Switch>[],
  ownerOrAdmin: null as boolean | null,
  config: {} as Record<string, unknown>,
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: fixture.section, instances: [], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/thread-preferences", () => ({
  useShowThreads: () => fixture.showThreads,
  useShowThreadsChoice: () => fixture.showThreads,
  setShowThreads: fixture.setShowThreads,
}));
vi.mock("@/lib/run-card-preferences", () => ({
  useShowRunCard: () => fixture.showRunCard,
  setShowRunCard: fixture.setShowRunCard,
}));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => fixture.notificationSounds,
  setNotificationSounds: fixture.setNotificationSounds,
  useNotificationFeed: () => false,
  setNotificationFeed: vi.fn(),
  useFinishedNotifications: () => true,
  setFinishedNotifications: vi.fn(),
}));
vi.mock("@/lib/interface-mode", () => ({
  useAdvancedMode: () => fixture.advancedMode,
  setAdvancedMode: fixture.setAdvancedMode,
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
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

beforeEach(() => {
  vi.clearAllMocks();
  fixture.section = "appearance";
  fixture.showThreads = true;
  fixture.showRunCard = true;
  fixture.notificationSounds = true;
  // these pin the Advanced rail; Simple has its own suite (SettingsModal.simple.test.ts)
  fixture.advancedMode = true;
  fixture.switches = [];
  fixture.ownerOrAdmin = null;
  fixture.config = {};
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));

const render = () => renderToStaticMarkup(createElement(SettingsModal));
const pages = (html: string) => [...html.matchAll(/data-settings-page="([^"]+)"/g)].map((match) => match[1]);
const blocks = (html: string) => [...html.matchAll(/data-settings-block="([^"]+)"/g)].map((match) => match[1]);

describe("Settings flat Advanced rail (Muse style)", () => {
  it("files every section under one of the flat Advanced pages without duplicates", () => {
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual(["you", "ai", "computers", "account"]);
    const ids = SECTIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(24);
    const placed = ADVANCED_PAGES.flatMap((page) => page.sections);
    expect(new Set(placed).size).toBe(placed.length);
    expect(ids.filter((id) => !placed.includes(id))).toEqual([]);
  });

  it("draws the desktop Advanced pages as a flat list with no group headers", () => {
    vi.stubGlobal("window", { ogb: { environments: {}, organization: {}, cloudAccount: {} } });
    const html = render();
    expect(html).toContain("glass-surface");
    expect(html).not.toContain("data-settings-group=");
    expect(pages(html)).toEqual([
      "general", "appearance", "ai", "connectors", "computer", "vault", "channels", "devices", "data", "billing", "team", "experimental",
    ]);
    expect(html).toContain(">Models &amp; AI</span>");
    expect(html).toContain(">Message channels</span>");
    expect(html).toContain(">Data controls</span>");
  });

  it("shows Team & permissions for a hosted workspace's admins, and renders People and Activity blocks there", () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:8799" } });
    fixture.ownerOrAdmin = true;
    fixture.section = "people";
    const html = render();
    expect(pages(html)).toContain("team");
    expect(blocks(html)).toEqual(["people", "activity"]);
  });

  it("gives a team's admins its Bot access block under Team & permissions, and nobody else", () => {
    fixture.config = { team: { id: "team-acme", name: "Acme" }, cloudHome: true };
    fixture.ownerOrAdmin = true;
    fixture.section = "botAccess";
    expect(pages(render())).toContain("team");
    expect(blocks(render())).toContain("botAccess");
    fixture.ownerOrAdmin = false;
    expect(pages(render())).not.toContain("team");
    fixture.config = {};
    fixture.ownerOrAdmin = true;
    expect(blocks(render())).not.toContain("botAccess");
  });

  it("shows a paired remote client only Appearance and Devices", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true }, environments: {}, organization: {}, cloudAccount: {} } });
    expect(pages(render())).toEqual(["appearance", "devices"]);
  });

  it("lands deep links on their owning flat page and renders the target block", () => {
    vi.stubGlobal("window", { ogb: { environments: {} } });
    fixture.section = "remote" as AppSettingsSection;
    const remoteHtml = render();
    expect(remoteHtml).toContain('data-settings-page="devices"');
    expect(remoteHtml).toContain('aria-current="page"');
    expect(blocks(remoteHtml)).toEqual(["companion", "desktopWorkspaces"]);

    fixture.section = "connections";
    const keysHtml = render();
    expect(keysHtml).toMatch(/data-settings-page="connectors"[^>]*aria-current="page"/);
    expect(blocks(keysHtml)).toContain("connections");

    fixture.section = "channels";
    const channelsHtml = render();
    expect(channelsHtml).toMatch(/data-settings-page="channels"[^>]*aria-current="page"/);
    expect(blocks(channelsHtml)).toEqual(["channels"]);
  });
});

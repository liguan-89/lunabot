// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CN_MCP_APPS } from "@/lib/cn-mcp-apps";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  openBotSettings: vi.fn(),
  openExternalLink: vi.fn(async () => true),
  dispatch: vi.fn(),
  store: { bots: [] as unknown[] },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: fixture.store, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.openExternalLink }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));
vi.mock("./bot-panel/panel-link", () => ({ openBotSettings: fixture.openBotSettings }));

import { CnMcpPanel } from "./CnMcpPanel";

interface Server { name: string; type: "http" | "sse"; url: string; headerKeys: string[]; enabled: boolean }

let host: HTMLDivElement;
let root: Root;
let servers: Server[];
let catalog: { servers: unknown[]; fetchedAt: number; fresh: boolean };

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
const tile = (id: string) => host.querySelector<HTMLElement>(`[data-cn-tile="${id}"]`);
const tileButton = (id: string, label: string) => [...(tile(id)?.querySelectorAll("button") ?? [])].find((element) => element.textContent?.trim() === label);
const calls = (method: string) => fixture.api.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === method)
  .map(([path, init]) => [path as string, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : undefined] as const);

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(CnMcpPanel)));
  await settle();
}

/** React tracks its own copy of an input's value, so the native setter is what makes a typed value reach the component. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** The panel's API: servers first, the catalog second, then whatever each call answers. */
function answerApi(overrides: Record<string, unknown> = {}) {
  fixture.api.mockImplementation((path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    if (key in overrides) return Promise.resolve(overrides[key]);
    if (path === "/api/mcp/servers" && !init?.method) return Promise.resolve({ servers });
    if (path.startsWith("/api/mcp/cn-catalog")) return Promise.resolve(catalog);
    if (path === "/api/vault/secrets") return Promise.resolve({ secret: { id: "11111111-1111-1111-1111-111111111111" } });
    if (path === "/api/mcp/servers" && init?.method === "POST") return Promise.resolve({ servers });
    if (path.endsWith("/test")) return Promise.resolve({ ok: true, tools: 2, total: 2 });
    if (init?.method === "PATCH" || init?.method === "DELETE") return Promise.resolve({ servers });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  servers = [];
  catalog = { servers: [], fetchedAt: 1_700_000_000_000, fresh: true };
  fixture.store = { bots: [] };
  answerApi();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("CnMcpPanel", () => {
  it("groups the services and opens the groups with services in them", async () => {
    await mount();
    expect(host.querySelector('[data-cn-group="life"]')).not.toBeNull();
    expect(tile("cn-12306")).not.toBeNull();
    // Social starts open too; Developer starts closed, so its services are not rendered yet.
    expect(tile("cn-gitee")).toBeNull();
  });

  it("marks the services that need no key", async () => {
    await mount();
    expect(tile("cn-12306")!.textContent).toContain("No key needed");
    expect(tile("cn-amap")!.textContent).not.toContain("No key needed");
  });

  it("connects a keyless service without asking for a key, and turns it on once it answers", async () => {
    await mount();
    await act(async () => { tileButton("cn-12306", "Connect")!.click(); });
    await settle();
    expect(fixture.api).not.toHaveBeenCalledWith("/api/vault/secrets", expect.anything());
    expect(calls("POST")).toContainEqual(["/api/mcp/servers", { name: "cn-12306", type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp", enabled: false }]);
    expect(fixture.api).toHaveBeenCalledWith("/api/mcp/servers/cn-12306/test", { method: "POST" });
    expect(calls("PATCH")).toContainEqual(["/api/mcp/servers/cn-12306", { enabled: true }]);
  });

  it("keeps a parameter key in the Vault and sends only the pointer", async () => {
    await mount();
    await type(tile("cn-amap")!.querySelector("input")!, "my-amap-key");
    await act(async () => { tileButton("cn-amap", "Connect")!.click(); });
    await settle();
    const saved = fixture.api.mock.calls.find(([path]) => path === "/api/vault/secrets");
    expect(saved?.[1]?.body).toContain("my-amap-key");
    expect(calls("POST")).toContainEqual(["/api/mcp/servers", {
      name: "cn-amap", type: "http", url: "https://mcp.amap.com/mcp?key=vault:11111111-1111-1111-1111-111111111111", enabled: false,
      vaultKeys: ["11111111-1111-1111-1111-111111111111"],
    }]);
    const added = calls("POST").filter(([path]) => path === "/api/mcp/servers");
    expect(JSON.stringify(added)).not.toContain("my-amap-key");
  });

  it("keeps a header key in the Vault and sends only the pointer", async () => {
    await mount();
    await type(tile("cn-weibo")!.querySelector("input")!, "my-weibo-key");
    await act(async () => { tileButton("cn-weibo", "Connect")!.click(); });
    await settle();
    expect(calls("POST")).toContainEqual(["/api/mcp/servers", {
      name: "cn-weibo", type: "http", url: "https://mcp.52choujiang.com/weibo/mcp",
      headers: { Authorization: "Bearer vault:11111111-1111-1111-1111-111111111111" }, enabled: false,
      vaultKeys: ["11111111-1111-1111-1111-111111111111"],
    }]);
    const added = calls("POST").filter(([path]) => path === "/api/mcp/servers");
    expect(JSON.stringify(added)).not.toContain("my-weibo-key");
  });

  it("asks for a key before connecting a service that takes one", async () => {
    await mount();
    await act(async () => { tileButton("cn-amap", "Connect")!.click(); });
    await settle();
    expect(host.textContent).toContain("Paste a key first.");
    expect(calls("POST")).toHaveLength(0);
  });

  it("says a refused key was refused, and does not turn the server on", async () => {
    answerApi({ "POST /api/mcp/servers/cn-12306/test": { ok: false, error: "401" } });
    await mount();
    await act(async () => { tileButton("cn-12306", "Connect")!.click(); });
    await settle();
    expect(host.textContent).toContain("didn't accept that key");
    expect(calls("PATCH")).toHaveLength(0);
  });

  it("shows a connected service as connected, and disconnects it", async () => {
    servers = [{ name: "cn-12306", type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp", headerKeys: [], enabled: true }];
    await mount();
    expect(tileButton("cn-12306", "Disconnect")).toBeTruthy();
    await act(async () => { tileButton("cn-12306", "Disconnect")!.click(); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/mcp/servers/cn-12306", { method: "DELETE" });
  });

  it("does not call a service connected while its key is missing", async () => {
    servers = [{ name: "cn-amap", type: "http", url: "https://mcp.amap.com/mcp", headerKeys: [], enabled: true }];
    await mount();
    expect(tileButton("cn-amap", "Connect")).toBeTruthy();
  });

  it("counts a header service as connected only while its header is set", async () => {
    servers = [{ name: "cn-weibo", type: "http", url: "https://mcp.52choujiang.com/weibo/mcp", headerKeys: [], enabled: true }];
    await mount();
    expect(tileButton("cn-weibo", "Connect")).toBeTruthy();
  });

  it("lists registry entries that are not connected yet, and adds one as a server", async () => {
    catalog = {
      fetchedAt: 1_700_000_000_000,
      fresh: true,
      servers: [{
        name: "cn.pianam.mcp/devtools-mcp",
        title: "Pianam Devtools",
        description: "Developer tools",
        url: "https://mcp.pianam.cn/devtools-mcp/mcp",
        transport: "http",
        headerKeys: [],
      }],
    };
    await mount();
    const entry = host.querySelector<HTMLElement>('[data-cn-registry-tile="cn.pianam.mcp/devtools-mcp"]')!;
    expect(entry.textContent).toContain("Pianam Devtools");
    await act(async () => { [...entry.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add")!.click(); });
    await settle();
    expect(calls("POST")).toContainEqual(["/api/mcp/servers", { name: "devtools-mcp", type: "http", url: "https://mcp.pianam.cn/devtools-mcp/mcp", enabled: false }]);
  });

  it("gives a registry entry a free name when its own is taken", async () => {
    servers = [{ name: "devtools-mcp", type: "http", url: "https://other.test/mcp", headerKeys: [], enabled: true }];
    catalog = {
      fetchedAt: 1_700_000_000_000,
      fresh: true,
      servers: [{
        name: "cn.pianam.mcp/devtools-mcp",
        title: "Pianam Devtools",
        description: "",
        url: "https://mcp.pianam.cn/devtools-mcp/mcp",
        transport: "http",
        headerKeys: [],
      }],
    };
    await mount();
    const entry = host.querySelector<HTMLElement>('[data-cn-registry-tile="cn.pianam.mcp/devtools-mcp"]')!;
    await act(async () => { [...entry.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add")!.click(); });
    await settle();
    expect(calls("POST")).toContainEqual(["/api/mcp/servers", { name: "devtools-mcp-2", type: "http", url: "https://mcp.pianam.cn/devtools-mcp/mcp", enabled: false }]);
  });

  it("leaves out a registry entry the cards above already offer", async () => {
    catalog = {
      fetchedAt: 1_700_000_000_000,
      fresh: true,
      servers: [{
        name: "cn.pianam.mcp/12306-train-mcp",
        title: "China 12306 Train Tickets MCP",
        description: "",
        url: "https://mcp.pianam.cn/train-mcp/mcp",
        transport: "http",
        headerKeys: [],
      }],
    };
    await mount();
    expect(host.querySelector('[data-cn-registry-tile="cn.pianam.mcp/12306-train-mcp"]')).toBeNull();
  });

  it("leaves a registry entry out once its address is already a server", async () => {
    servers = [{ name: "train", type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp", headerKeys: [], enabled: true }];
    catalog = {
      fetchedAt: 1_700_000_000_000,
      fresh: true,
      servers: [{ name: "cn.pianam.mcp/12306-train-mcp", title: "12306", description: "", url: "https://mcp.pianam.cn/train-mcp/mcp", transport: "http", headerKeys: [] }],
    };
    await mount();
    expect(host.querySelector('[data-cn-registry-tile="cn.pianam.mcp/12306-train-mcp"]')).toBeNull();
  });

  it("says the registry answer is old when it could not be refreshed", async () => {
    catalog = { servers: [], fetchedAt: 1, fresh: false };
    await mount();
    expect(host.textContent).toContain("Showing what was found last time");
  });

  it("asks for a refresh when the person asks", async () => {
    await mount();
    const refresh = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh")!;
    await act(async () => { refresh.click(); });
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/mcp/cn-catalog?refresh=1");
  });

  it("points at the MCP servers page for the command-line services", async () => {
    await mount();
    expect(host.textContent).toContain("Feishu, DingTalk or Yuque");
  });

  it("opens where a key comes from", async () => {
    await mount();
    const getKey = [...tile("cn-amap")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Get a"))!;
    await act(async () => { getKey.click(); });
    expect(fixture.openExternalLink).toHaveBeenCalledWith("https://lbs.amap.com/dev/console/quick-register");
  });

  it("offers each bot's access settings for a connected service", async () => {
    fixture.store = { bots: [{ id: "scout", name: "Scout" }] };
    await mount();
    const manage = [...tile("cn-12306")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Manage Scout"))!;
    await act(async () => { manage.click(); });
    expect(fixture.openBotSettings).toHaveBeenCalledWith(fixture.dispatch, "access", { botId: "scout", page: "mcp" });
  });

  it("has a card for every service it lists", async () => {
    await mount();
    for (const entry of CN_MCP_APPS) {
      // Only the groups that start open render their cards; opening the rest would need a click, so check those two.
      if (entry.group === "work" || entry.group === "dev") continue;
      expect(tile(entry.id), entry.id).not.toBeNull();
    }
  });
});

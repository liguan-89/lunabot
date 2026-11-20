// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fx = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  refreshModels: vi.fn(),
  refreshInstances: vi.fn(),
  config: {
    openaiCompat: { configured: true, url: "https://api.example.com/v1", protocol: "openai" as const, models: ["gpt-5"], providerId: "dex" },
    defaultModelSelection: null as { instanceId: string; model: string } | null,
    hiddenModels: [] as string[],
  },
  bots: [] as Array<{ id: string; name: string; modelSelection: { instanceId: string; model: string } }>,
  routines: [] as Array<{ name: string; modelSelection?: { instanceId: string; model: string } }>,
}));

const instance = {
  instanceId: "pi", driverKind: "piAgent", displayName: "pi",
  snapshot: { state: "available" },
  models: {
    default: "dex/gpt-5",
    options: [
      { id: "dex/gpt-5", label: "gpt-5 (Custom)", custom: true, provider: "dex" },
      { id: "anthropic/claude-sonnet", label: "Claude Sonnet", provider: "anthropic" },
      { id: "openai/gpt-4o", label: "GPT-4o", provider: "openai" },
      { id: "google/gemini", label: "Gemini", provider: "google" },
      { id: "xai/grok", label: "Grok", provider: "xai" },
      { id: "deepseek/v4", label: "DeepSeek V4", provider: "deepseek" },
      { id: "moonshot/kimi", label: "Kimi", provider: "moonshot" },
    ],
  },
};

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    api: (...args: unknown[]) => fx.api(...args),
    useStore: () => ({
      state: { ...actual.initialState, instances: [instance], config: fx.config, bots: fx.bots, routines: fx.routines },
      dispatch: fx.dispatch,
      refreshModels: fx.refreshModels,
      refreshInstances: fx.refreshInstances,
    }),
  };
});

const { ModelManagement } = await import("./ModelManagement");

let host: HTMLDivElement;
let root: Root;
const row = (id: string) => document.querySelector<HTMLElement>(`[data-managed-model="${id}"]`);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);

beforeEach(() => {
  setLocale("en");
  fx.api.mockReset();
  fx.dispatch.mockReset();
  fx.refreshModels.mockReset();
  fx.refreshModels.mockResolvedValue(undefined);
  fx.refreshInstances.mockReset();
  fx.refreshInstances.mockResolvedValue(undefined);
  fx.config = {
    openaiCompat: { configured: true, url: "https://api.example.com/v1", protocol: "openai", models: ["gpt-5"], providerId: "dex" },
    defaultModelSelection: null,
    hiddenModels: [],
  };
  fx.bots = [];
  fx.routines = [];
  vi.stubGlobal("ogb", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(ModelManagement)));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Luna Bot models", () => {
  it("lists the catalog's models, marks the custom provider's and offers removal only for those", () => {
    expect(row("dex/gpt-5")?.textContent).toContain("gpt-5");
    expect(row("dex/gpt-5")?.textContent).toContain("Custom");
    expect(row("dex/gpt-5")?.querySelector('[aria-label="Remove gpt-5"]')).not.toBeNull();
    expect(row("anthropic/claude-sonnet")?.querySelector("[data-managed-custom]")).toBeNull();
    expect(row("anthropic/claude-sonnet")?.querySelector('[aria-label^="Remove"]')).toBeNull();
  });

  it("blocks an invalid base URL before any config request", async () => {
    const url = document.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "https://user:pass@api.example.com/v1");
      url.dispatchEvent(new Event("input", { bubbles: true }));
      url.focus();
      url.blur();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Remove the username, password, query string or fragment"));
    expect(fx.api).not.toHaveBeenCalled();
  });

  it("adds a model to the custom provider and refreshes the catalog", async () => {
    fx.api.mockImplementation(async (path: string, init: { body?: string }) => {
      if (path === "/api/config") return { ...fx.config, openaiCompat: { ...fx.config.openaiCompat, models: JSON.parse(init.body!).openaiCompat.models } };
      return {};
    });
    const input = document.querySelector<HTMLInputElement>("[data-managed-model-input]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gpt-4o");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => button("Add model")!.click());
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(fx.api.mock.calls.find(([path]) => path === "/api/config")![1].body);
    expect(body.openaiCompat.models).toEqual(["gpt-5", "gpt-4o"]);
    expect(fx.refreshModels).toHaveBeenCalledWith("pi");
  });

  it("sets the new-bot default through the config patch", async () => {
    fx.api.mockResolvedValue(fx.config);
    flushSync(() => button("Set as default")!.click());
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PATCH" })));
    const body = JSON.parse(fx.api.mock.calls[0]![1].body);
    expect(body).toEqual({ defaultModelSelection: { instanceId: "pi", model: "dex/gpt-5" } });
  });

  it("filters a long model list by name or id", () => {
    const search = document.querySelector<HTMLInputElement>("[data-managed-model-search]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "gemini");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll("[data-managed-model]")).toHaveLength(1);
    expect(row("google/gemini")).not.toBeNull();
  });

  it("keeps Add disabled until the provider has a base URL", () => {
    fx.config = { ...fx.config, openaiCompat: { ...fx.config.openaiCompat, url: "" } };
    flushSync(() => root.render(createElement(ModelManagement)));
    const input = document.querySelector<HTMLInputElement>("[data-managed-model-input]")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gpt-4o");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Add model")!.disabled).toBe(true);
    expect(host.textContent).toContain("Fill in the base URL");
  });

  it("asks before removing a model a bot still uses", async () => {
    fx.bots = [{ id: "b1", name: "Atlas", modelSelection: { instanceId: "pi", model: "dex/gpt-5" } }];
    fx.api.mockImplementation(async (path: string, init: { body?: string }) => {
      if (path === "/api/config") return { ...fx.config, openaiCompat: { ...fx.config.openaiCompat, models: JSON.parse(init.body!).openaiCompat.models } };
      return {};
    });
    flushSync(() => root.render(createElement(ModelManagement)));
    flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove gpt-5"]')!.click());
    expect(document.body.textContent).toContain("Remove gpt-5?");
    expect(document.body.textContent).toContain("Atlas's chat model");
    flushSync(() => button("Remove anyway")!.click());
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(fx.api.mock.calls.find(([path]) => path === "/api/config")![1].body);
    expect(body.openaiCompat.models).toEqual([]);
  });

  it("hides any model and restores it from the Hidden list", async () => {
    fx.api.mockImplementation(async (path: string, init: { body?: string }) => {
      if (path === "/api/config") return { ...fx.config, hiddenModels: JSON.parse(init.body!).hiddenModels };
      return {};
    });
    flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Hide GPT-4o"]')!.click());
    await vi.waitFor(() => expect(fx.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PATCH" })));
    const hidden = JSON.parse(fx.api.mock.calls.find(([path]) => path === "/api/config")![1].body).hiddenModels;
    expect(hidden).toEqual(["openai/gpt-4o"]);
    expect(fx.refreshInstances).toHaveBeenCalledWith({ cached: true });
    await vi.waitFor(() => expect(host.textContent).toContain("GPT-4o is hidden"));

    fx.config = { ...fx.config, hiddenModels: ["openai/gpt-4o"] };
    flushSync(() => root.render(createElement(ModelManagement)));
    expect(document.querySelector('[data-managed-hidden-model="openai/gpt-4o"]')).not.toBeNull();
    flushSync(() => button("Restore")!.click());
    await vi.waitFor(() => expect(fx.api.mock.calls.filter(([path]) => path === "/api/config")).toHaveLength(2));
    const restored = JSON.parse(fx.api.mock.calls.filter(([path]) => path === "/api/config")[1]![1].body).hiddenModels;
    expect(restored).toEqual([]);
  });

  it("does not hide the model the engine or new bots default to", () => {
    expect(document.querySelector<HTMLButtonElement>('[data-managed-model="dex/gpt-5"] [data-managed-hide]')!.disabled).toBe(true);
  });

  it("groups models by provider and collapses/expands a provider section", () => {
    expect(document.querySelector('[data-managed-provider-group="anthropic"]')).not.toBeNull();
    expect(row("anthropic/claude-sonnet")).not.toBeNull();
    const toggle = document.querySelector<HTMLButtonElement>('[data-managed-provider-toggle="anthropic"]')!;
    flushSync(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(row("anthropic/claude-sonnet")).toBeNull();
    flushSync(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(row("anthropic/claude-sonnet")).not.toBeNull();
  });

  it("tests connectivity and renders latency or failure status", async () => {
    const testBtn = document.querySelector<HTMLButtonElement>("[data-managed-connectivity-test]")!;
    flushSync(() => testBtn.click());
    await vi.waitFor(() => expect(document.querySelector('[data-managed-probe-status="ok"]')).not.toBeNull());
    expect(fx.refreshModels).toHaveBeenCalledWith("pi");
    expect(document.querySelector('[data-managed-probe-status="ok"]')!.textContent).toContain("ms");

    fx.refreshModels.mockRejectedValueOnce(new Error("timeout"));
    flushSync(() => testBtn.click());
    await vi.waitFor(() => expect(document.querySelector('[data-managed-probe-status="error"]')).not.toBeNull());
    expect(document.querySelector('[data-managed-probe-status="error"]')!.textContent).toContain("timeout");
  });
});
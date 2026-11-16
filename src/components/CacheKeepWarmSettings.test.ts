import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { CacheKeepWarmSettings } from "./CacheKeepWarmSettings";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "cacheKeepWarm">,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return fixture.values[index] ??= { current: initial };
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = CacheKeepWarmSettings(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  return {
    html,
    window: all.find((node) => node.props.id === "cache-keepwarm-window")!,
  };
}
const chooseWindow = (node: Node, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [];
  fixture.config = { cacheKeepWarm: { enabled: true, windowMinutes: 180 } };
  fixture.api.mockReset().mockResolvedValue(fixture.config);
  fixture.dispatch.mockReset();
});

describe("CacheKeepWarmSettings", () => {
  it("does not save an unchanged window and saves a changed window", async () => {
    chooseWindow(render().window, "180");
    expect(fixture.api).not.toHaveBeenCalled();

    chooseWindow(render().window, "360");
    await flush();
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ cacheKeepWarm: { enabled: true, windowMinutes: 360 } }),
    });
  });
});

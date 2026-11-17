import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneVerifyRow } from "./PhoneVerifyRow";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, api: vi.fn(), dispatch: vi.fn(), config: {} as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
const nodes = (value: ReactNode): Node[] => Children.toArray(value).flatMap((child) => (isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render() {
  let tree: ReactNode = null;
  function Capture() { fixture.index = 0; tree = PhoneVerifyRow(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, toggle: nodes(tree).find((node) => node.props.role === "switch" || node.props["aria-label"] === "Check what a bot says it did on your phone"), tree };
}

beforeEach(() => { fixture.values = []; fixture.config = {}; fixture.api.mockReset(); fixture.dispatch.mockReset(); });

describe("the phone answer check setting", () => {
  it("is off when the config does not mention it, and titled in plain words", () => {
    const view = render();
    expect(view.html).toContain("Check what a bot says it did on your phone");
    expect(view.html).toContain('aria-checked="false"');
  });

  it("shows on only for the log mode", () => {
    fixture.config = { features: { phoneVerify: "log" } };
    expect(render().html).toContain('aria-checked="true"');
    fixture.config = { features: { phoneVerify: "off" } };
    expect(render().html).toContain('aria-checked="false"');
  });

  it("turning it on saves the log mode", async () => {
    const config = { features: { phoneVerify: "log" } };
    fixture.api.mockResolvedValue(config);
    (render().toggle!.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { phoneVerify: "log" } }) });
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
  });

  it("turning it back off saves off", async () => {
    const config = { features: { phoneVerify: "off" } };
    fixture.config = { features: { phoneVerify: "log" } };
    fixture.api.mockResolvedValue(config);
    (render().toggle!.props.onClick as () => void)();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { phoneVerify: "off" } }) });
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
  });

  it("shows a short error when saving fails", async () => {
    fixture.api.mockRejectedValue("nope");
    (render().toggle!.props.onClick as () => void)();
    await flush();
    expect(render().html).toContain("Couldn&#x27;t change this setting. Try again.");
  });
});
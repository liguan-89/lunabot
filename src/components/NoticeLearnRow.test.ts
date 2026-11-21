import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeLearnRow } from "./NoticeLearnRow";

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
  function Capture() { fixture.index = 0; tree = NoticeLearnRow({ simple: false }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  const select = nodes(tree).find((node) => typeof node.props.value === "string" && typeof node.props.onChange === "function");
  return { html, select, tree };
}

beforeEach(() => { fixture.values = []; fixture.config = {}; fixture.api.mockReset(); fixture.dispatch.mockReset(); });

describe("the notification learning setting", () => {
  it("is off when the config does not mention it, and titled in plain words", () => {
    const view = render();
    expect(view.html).toContain("Learn from your phone notifications");
    expect(view.select?.props.value).toBe("off");
  });

  it("shows the saved level", () => {
    fixture.config = { features: { noticeLearn: "balanced" } };
    expect(render().select?.props.value).toBe("balanced");
  });

  it("picking a level saves it to features.noticeLearn", async () => {
    const config = { features: { noticeLearn: "conservative" } };
    fixture.api.mockResolvedValue(config);
    const select = render().select!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "conservative" } });
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { noticeLearn: "conservative" } }) });
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config });
  });
});

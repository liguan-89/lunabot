// The screenmap's pure core: what counts as a page anchor, how a page is
// recognized, how one learned step folds in, and what the model reads.
import { describe, expect, it } from "vitest";

import {
  learnStep, nodeFor, pathBetween, recognize, renderMap, screenId, skeletonSignature,
  skeletonTexts, stableAnchorText,
  type MapScreen,
} from "./phone-screenmap.ts";

const element = (over: Partial<Parameters<typeof skeletonTexts>[0][number]> & { text?: string }) => ({
  text: null, description: null, viewId: null, class: null, bounds: null, editable: false, scrollable: false, ...over,
});

const screen = (app: string, elements: Parameters<typeof skeletonTexts>[0]): MapScreen => ({ app, elements });

const first = screen("com.app", [element({ text: "消息" })]);
const second = screen("com.app", [element({ text: "聊天详情" })]);

describe("skeleton anchors", () => {
  it("takes fixed chrome only: no digits, no list rows, no typed text, nothing long", () => {
    expect(stableAnchorText("消息")).toBe(true);
    expect(stableAnchorText("3 条新消息")).toBe(false);
    expect(stableAnchorText("¥1,299 起")).toBe(false);
    expect(stableAnchorText("a very long page title that runs on")).toBe(false);
    const page = screen("com.app", [
      element({ text: "消息", viewId: "com.app/id/title" }),
      element({ text: "张三", bounds: [0, 200, 1080, 300] }),
      element({ text: "李四", bounds: [0, 300, 1080, 400] }),
      element({ text: "列表", class: "RecyclerView", scrollable: true, bounds: [0, 200, 1080, 800] }),
      element({ text: "搜索好友", editable: true }),
      element({ description: "确定", bounds: [0, 1800, 1080, 1900] }),
    ]);
    const anchors = skeletonTexts(page.elements);
    expect(anchors).toContain("消息");
    expect(anchors).toContain("确定");
    // Rows inside the scrollable list and the field's typed text are not anchors.
    expect(anchors).not.toContain("张三");
    expect(anchors).not.toContain("搜索好友");
    // A view id anchors first, so the title leads.
    expect(anchors.indexOf("消息")).toBe(0);
  });
});

describe("page identity", () => {
  it("the same skeleton is always the same page, anchor order aside", () => {
    const a = screenId("com.app", skeletonSignature(["消息", "确定"]));
    const b = screenId("com.app", skeletonSignature(["确定", "消息"]));
    const c = screenId("com.app", skeletonSignature(["通讯录", "确定"]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("recognize", () => {
  const page = (text: string) => nodeFor(screen("com.app", [element({ text: "确定" }), element({ text })]));
  it("a rare anchor hit names the page; chrome alone names nothing", () => {
    const nodes = [page("账单详情"), page("通讯录")];
    const hit = recognize(new Set(["确定", "账单详情"]), nodes);
    expect(hit?.id).toBe(screenId("com.app", skeletonSignature(["确定", "账单详情"])));
    // «确定» sits on both pages, so its rarity pulls the score under the floor.
    expect(recognize(new Set(["确定"]), nodes)).toBeNull();
    expect(recognize(new Set(["账单详情", "别处的话"]), nodes)?.confidence).toBeGreaterThan(0);
  });
});

describe("learnStep", () => {
  it("one step folds both pages in and one edge between them, counted on a repeat", () => {
    const graph = learnStep(learnStep({ app: "com.app", nodes: {} }, first, { tool: "PHONE_UI_TAP", target: "张三" }, second), first, { tool: "PHONE_UI_TAP", target: "张三" }, second);
    const from = Object.values(graph.nodes).find((node) => "消息" in node.anchors)!;
    const to = Object.values(graph.nodes).find((node) => "聊天详情" in node.anchors)!;
    expect(Object.values(from.edges)).toEqual([{ action: "PHONE_UI_TAP", target: "张三", to: to.app && Object.keys(graph.nodes).find((id) => graph.nodes[id] === to)!, count: 2 }]);
    expect(to.visits).toBe(2);
  });

  it("a revisit of the same page adds no edge, and another app's page never joins this graph", () => {
    const graph = learnStep({ app: "com.app", nodes: {} }, first, { tool: "PHONE_UI_TAP", target: null }, first);
    expect(Object.values(graph.nodes)[0]!.edges).toEqual({});
    const other = learnStep({ app: "com.app", nodes: {} }, first, { tool: "PHONE_UI_LAUNCH", target: null }, screen("com.other", [element({ text: "首页" })]));
    expect(Object.keys(other.nodes)).toHaveLength(0);
  });

  it("a screen the recognizer never saw still becomes a page", () => {
    const graph = learnStep({ app: "com.app", nodes: {} }, first, { tool: "PHONE_UI_TAP", target: null }, second);
    expect(Object.keys(graph.nodes)).toHaveLength(2);
  });
});

describe("renderMap", () => {
  it("lists the pages and, when a page is current, the way out of it", () => {
    let graph = learnStep({ app: "com.app", nodes: {} }, first, { tool: "PHONE_UI_TAP", target: "张三" }, second);
    const listId = screenId("com.app", skeletonSignature(["消息"]));
    expect(renderMap(graph, null)).toContain("Pages (2)");
    const out = renderMap(graph, listId);
    expect(out).toContain("From here:");
    expect(out).toContain('tap "张三"');
    // Twelve pages cap the list; a long render is cut, never grown.
    for (let index = 0; index < 20; index += 1) {
      graph = learnStep(graph, screen("com.app", [element({ text: `第${index}屏` })]), { tool: "PHONE_UI_TAP", target: null }, screen("com.app", [element({ text: `页${index}` })]));
    }
    expect(renderMap(graph, null).length).toBeLessThanOrEqual(1200);
    expect(pathBetween(graph, listId, listId)).toEqual([]);
  });
});

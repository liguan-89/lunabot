// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import type { McpChangeRequest } from "../../shared/mcp-request";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [] }, dispatch: fixture.dispatch }),
}));

import { OptionCard } from "./OptionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLocale("en");
});

function message(action: McpChangeRequest["action"], option: string): Message {
  return {
    id: "mcp-card", role: "bot", kind: "options", at: 1,
    card: {
      title: `${option} linear?`, subtitle: "https://mcp.linear.app/mcp", options: [option, "Cancel"],
      requestId: "mcp-request", tool: "mcp_server", fixedOptions: true,
      mcpRequest: { requestId: "mcp-request", botId: "bot-1", threadId: "thread-1", action, name: "linear", targetHash: "0".repeat(64) },
    },
  };
}

const render = (message: Message) => act(() => root.render(createElement(OptionCard, { botId: "bot-1", threadId: "thread-1", message })));
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-ask-choice]")];

const actions = [
  ["enable", "Turn on", "开启"],
  ["update", "Change", "更改"],
  ["remove", "Remove", "移除"],
] as const;

describe("MCP option cards", () => {
  it.each(actions)("localizes MCP %s choices but answers with their original protocol tokens", (action, english, chinese) => {
    const card = message(action, english);
    render(card);
    expect(buttons().map((button) => button.textContent)).toEqual([english, "Cancel"]);
    setLocale("zh");
    render(card);
    expect(buttons().map((button) => button.textContent)).toEqual([chinese, "取消"]);
    act(() => buttons()[0]!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "answerCard", botId: "bot-1", threadId: "thread-1", messageId: "mcp-card", answer: english, groupId: undefined });
    act(() => buttons()[1]!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "answerCard", botId: "bot-1", threadId: "thread-1", messageId: "mcp-card", answer: "Cancel", groupId: undefined });
    expect(card.card!.options).toEqual([english, "Cancel"]);
  });

  it.each(actions)("localizes a settled MCP %s answer without changing the saved answer", (action, english, chinese) => {
    const card = message(action, english);
    card.card!.answered = "answer";
    card.card!.answeredText = english;
    render(card);
    expect(host.textContent).toContain(english);
    setLocale("zh");
    render(card);
    expect(host.textContent).toContain(chinese);
    expect(card.card!.answeredText).toBe(english);
    expect(host.querySelector("[data-ask-choice]")).toBeNull();
  });

  it("leaves bot-authored choices unchanged when there is no MCP request", () => {
    const card = message("update", "Change");
    delete card.card!.mcpRequest;
    setLocale("zh");
    render(card);
    expect(buttons().map((button) => button.textContent)).toEqual(["Change", "Cancel"]);
  });
});

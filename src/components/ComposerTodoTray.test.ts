// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  onCancelTurn: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, bots: [bot] },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { ComposerTodoTray, pendingTodoItems } from "./ComposerTodoTray";

const bot: Bot = {
  id: "atlas",
  threadId: "t1",
  name: "Atlas",
  title: "",
  description: "",
  color: "purple",
  notifications: false,
  unread: false,
  busy: false,
  messages: [],
  approvalMode: "ask",
  modelSelection: { instanceId: "inst-1", model: "fake" },
};

const approvalMsg = (id: string, requestId: string, tool = "Bash", command = "ls"): Message => ({
  id,
  role: "bot",
  kind: "options",
  text: "",
  at: 1,
  card: {
    requestId,
    tool,
    title: "",
    subtitle: command,
    options: ["Allow", "Deny"],
    commandAllowlist: { command, cwd: "/tmp", providerInstanceId: "inst-1" },
  },
});

const questionMsg = (id: string, requestId: string, question = "Which env?"): Message => ({
  id,
  role: "bot",
  kind: "options",
  text: "",
  at: 2,
  card: {
    requestId,
    title: question,
    subtitle: question,
    options: ["Staging", "Production"],
    questionRequest: {
      version: 1,
      questions: [{ question, options: [{ label: "Staging" }, { label: "Production" }] }],
    },
  },
});

const secretMsg = (id: string, label = "OpenAI API key"): Message => ({
  id,
  role: "bot",
  kind: "secret",
  text: "",
  at: 3,
  secret: {
    target: "openaiApiKey",
    label,
    placeholder: "sk-...",
    description: "Need key",
    helpUrl: "",
    requestKey: "openai",
  },
});

const signInMsg = (id: string, site = "github.com"): Message => ({
  id,
  role: "bot",
  kind: "signin",
  text: "",
  at: 4,
  signIn: {
    site,
    url: `https://${site}/login`,
    place: "browser",
  },
});

let root: Root;
let container: HTMLDivElement;

const render = (messages: Message[]) =>
  flushSync(() =>
    root.render(
      createElement(ComposerTodoTray, {
        messages,
        threadId: "t1",
        bot,
        bots: [bot],
        onCancelTurn: fixture.onCancelTurn,
      }),
    ),
  );

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("pendingTodoItems", () => {
  it("aggregates unresolved approval, question, secret, and signin items in order", () => {
    const items = pendingTodoItems([
      approvalMsg("m1", "req-1"),
      questionMsg("m2", "req-2"),
      secretMsg("m3"),
      signInMsg("m4"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["approval", "question", "secret", "signin"]);
  });

  it("ignores settled, expired, stopped, or superseded items", () => {
    const settledApproval = approvalMsg("m1", "req-1");
    settledApproval.card!.answered = "allow";
    const settledQuestion = questionMsg("m2", "req-2");
    settledQuestion.card!.dismissed = true;
    const settledSecret = secretMsg("m3");
    settledSecret.secret!.superseded = true;
    const settledSignIn = signInMsg("m4");
    settledSignIn.signIn!.answeredInChat = true;
    expect(pendingTodoItems([settledApproval, settledQuestion, settledSecret, settledSignIn])).toEqual([]);
  });
});

describe("ComposerTodoTray", () => {
  it("renders nothing when there are no pending items", () => {
    render([]);
    expect(container.querySelector("[data-todo-tray]")).toBeNull();
  });

  it("paginates across multiple pending items and collapses to a 36px pill bar", () => {
    render([approvalMsg("m1", "req-1"), questionMsg("m2", "req-2", "Pick target")]);
    expect(container.querySelector('[data-todo-tray="expanded"]')).not.toBeNull();
    expect(container.querySelector('[data-ask-card="approval"]')).not.toBeNull();
    expect(container.textContent).toContain("1 / 2");

    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Next pending item"]')!;
    flushSync(() => nextBtn.click());
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).toContain("Pick target");

    const collapseBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse pending tray"]')!;
    flushSync(() => collapseBtn.click());
    const collapsed = container.querySelector<HTMLButtonElement>('[data-todo-tray="collapsed"] button')!;
    expect(collapsed).not.toBeNull();
    expect(collapsed.className).toContain("h-9");
    flushSync(() => collapsed.click());
    expect(container.querySelector('[data-todo-tray="expanded"]')).not.toBeNull();
  });

  it("clamps index and auto-advances when the last item is resolved", () => {
    const m1 = approvalMsg("m1", "req-1");
    const m2 = questionMsg("m2", "req-2", "Second question");
    render([m1, m2]);
    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Next pending item"]')!;
    flushSync(() => nextBtn.click());
    expect(container.textContent).toContain("2 / 2");

    // Resolve m2 -> should clamp back to m1 (1 item left)
    const m2Resolved = { ...m2, card: { ...m2.card!, answered: "Staging" } };
    render([m1, m2Resolved]);
    expect(container.querySelector('[data-ask-card="approval"]')).not.toBeNull();
  });
});

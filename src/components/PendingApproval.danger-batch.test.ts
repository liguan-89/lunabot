import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

import { approvalBatchKey, pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "./PendingApproval";

const bot = { id: "bot-1", name: "Scout" } as Bot;

function makeMessage(id: string, extra: Partial<NonNullable<Message["card"]>> = {}): Message {
  return {
    id,
    at: 1,
    role: "bot",
    kind: "options",
    card: {
      title: "Approval needed",
      subtitle: "Read file",
      options: ["Allow", "Deny"],
      tool: "Read",
      requestId: `req-${id}`,
      allowSession: true,
      ...extra,
    },
  };
}

type Node = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  autoFocus?: boolean;
  className?: string;
}>;

function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

beforeEach(() => {
  fixture.admin = true;
  fixture.dispatch.mockReset();
});

describe("PendingApproval danger hierarchy and L1 batching", () => {
  it("renders danger styling, Confirm & allow label, and defaults focus to Deny", () => {
    const pending = pendingApprovals([makeMessage("1", { danger: true, tool: "Bash", subtitle: "rm -rf ~/" })])[0]!;
    const other = pendingApprovals([makeMessage("2", { danger: true, tool: "Bash", subtitle: "rm -rf ~/" })])[0]!;

    const panelHtml = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 2, index: 0 }));
    expect(panelHtml).toContain("bg-danger/[0.03]");

    const tree = PendingApprovalActions({
      pending,
      approvals: [pending, other],
      bot,
      threadId: "thread-1",
      onCancelTurn: vi.fn(),
      part: "primary",
    });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Confirm &amp; allow");
    expect(html).not.toContain("Allow all similar");

    const buttons = nodes(tree).filter((n) => n.type === "button");
    const deny = buttons.find((b) => b.props.children === "Deny");
    const allow = buttons.find((b) => b.props.children === "Confirm & allow");
    expect(deny?.props.autoFocus).toBe(true);
    expect(allow?.props.className).toContain("text-danger");
    expect(allow?.props.className).not.toMatch(/(^|\s)(border|shadow|ring-\d)/);
  });

  it("offers L1 batch allow for matching non-dangerous pending requests and dispatches allow for each", () => {
    const m1 = makeMessage("1", { tool: "Read", subtitle: "a.ts" });
    const m2 = makeMessage("2", { tool: "Read", subtitle: "b.ts" });
    const m3 = makeMessage("3", { tool: "Bash", subtitle: "git status" });
    const m4 = makeMessage("4", { tool: "Read", subtitle: "secret", danger: true });
    const approvals = pendingApprovals([m1, m2, m3, m4]);

    expect(approvalBatchKey(approvals[0]!)).toBe(approvalBatchKey(approvals[1]!));
    expect(approvalBatchKey(approvals[0]!)).not.toBe(approvalBatchKey(approvals[2]!));

    const tree = PendingApprovalActions({
      pending: approvals[0]!,
      approvals,
      bot,
      threadId: "thread-1",
      onCancelTurn: vi.fn(),
      part: "primary",
    });
    const buttons = nodes(tree).filter((n) => n.type === "button");
    const batchBtn = buttons.find((b) =>
      typeof b.props.children === "string" && b.props.children.includes("Allow all similar (2)"),
    );
    expect(batchBtn).toBeDefined();

    batchBtn!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "decideRequest",
      threadId: "thread-1",
      requestId: "req-1",
      behavior: "allow",
    }));
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "decideRequest",
      threadId: "thread-1",
      requestId: "req-2",
      behavior: "allow",
    }));
  });
});

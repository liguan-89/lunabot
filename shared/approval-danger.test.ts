import { describe, expect, it } from "vitest";
import { isDangerousApprovalRequest } from "./approval-danger.ts";
import { runtimeRequestCardFields } from "../server/request-card.ts";
import type { RuntimeEvent } from "./runtime-events.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
const event = (fields: Partial<RequestOpened> = {}): RequestOpened => ({
  eventId: "event",
  provider: "fixture",
  threadId: "thread",
  createdAt: "2026-11-04T12:00:00Z",
  type: "request.opened",
  requestId: "request",
  requestType: "permission",
  tool: "Bash",
  summary: "ls memory",
  ...fields,
});

describe("isDangerousApprovalRequest", () => {
  it("flags opaque outbound, always-ask, payment, and delete requests", () => {
    expect(isDangerousApprovalRequest({ tool: "Bash", opaque: true })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", always: true })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "fill_payment" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "delete" })).toBe(true);
  });

  it("flags destructive host-control tools only under local-computer scope", () => {
    expect(isDangerousApprovalRequest({ tool: "computer_delete_file", approvalScope: "local-computer" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "computer_delete_file" })).toBe(false);
    expect(isDangerousApprovalRequest({ tool: "Read", approvalScope: "local-computer" })).toBe(false);
  });

  it("flags destructive shell commands while allowing safe local cleanups", () => {
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "rm -rf /tmp/foo && rm -rf /" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "rm -rf ~/" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "git push --force origin main" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "git reset --hard HEAD~1" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "sudo apt-get remove foo" })).toBe(true);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "psql -c 'DROP TABLE users;'" })).toBe(true);

    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "rm -rf ./build" })).toBe(false);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "ls memory" })).toBe(false);
    expect(isDangerousApprovalRequest({ tool: "Bash", commandLine: "git status --short" })).toBe(false);
  });

  it("marks dangerous runtime request cards and strips reusable grants", () => {
    const command = { command: "git push --force origin main", cwd: "/repo", providerInstanceId: "pi" };
    const card = runtimeRequestCardFields(
      event({ tool: "Bash", summary: "git push --force origin main", commandLine: "git push --force origin main", allowSession: true }),
      { permission: true, guestDriven: false, commandAllowlist: command, allowKey: "bash:force" },
    );
    expect(card.danger).toBe(true);
    expect(card.allowSession).toBeUndefined();
    expect(card.allowKey).toBeUndefined();
    expect(card.commandAllowlist).toBeUndefined();
  });
});

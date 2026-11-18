import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { isDangerousApprovalRequest } from "../shared/approval-danger.ts";
import type { OptionCardData } from "../shared/wire.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
type RequestCardContext = Pick<OptionCardData, "commandAllowlist" | "allowKey" | "held" | "heldCode"> & {
  permission: boolean;
  guestDriven: boolean;
};

export function runtimeRequestCardFields(event: RequestOpened, context: RequestCardContext): Omit<OptionCardData, "title"> {
  const { permission, guestDriven } = context;
  const questions = event.questions?.length ? event.questions : undefined;
  const commandLine = event.commandLine ?? event.command?.command;
  const danger = permission && isDangerousApprovalRequest({
    tool: event.tool,
    commandLine,
    approvalScope: event.approvalScope,
  });
  return {
    subtitle: event.summary,
    ...(event.summaryCode ? {
      summaryCode: event.summaryCode,
      ...(event.summaryParams ? { summaryParams: event.summaryParams } : {}),
    } : {}),
    options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
    requestId: event.requestId,
    requestType: permission ? "permission" : "question",
    tool: permission ? event.tool : undefined,
    questionRequest: questions
      ? { version: 1, questions, ...(event.origin === "output" ? { origin: "output" as const } : {}) }
      : undefined,
    commandAllowlist: danger ? undefined : context.commandAllowlist,
    allowKey: danger ? undefined : context.allowKey,
    // A guest's turn or a dangerous action cannot leave a session grant behind.
    allowSession: permission && !danger && event.allowSession && !event.requiresExplicitApproval && !guestDriven ? true : undefined,
    ...(danger ? { danger: true } : {}),
    held: context.held,
    heldCode: context.heldCode,
    approvalScope: event.approvalScope,
  };
}

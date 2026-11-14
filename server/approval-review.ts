import type { Decider } from "./decider/index.ts";
import type { YesNoQuestion } from "./decider/types.ts";

export type ApprovalReviewVerdict = "approve" | "deny" | "escalate";

export type ApprovalReviewRequest = {
  tool: string;
  summary: string;
  commandLine?: string;
};

export type ApprovalReviewRules = { allow?: string[]; deny?: string[] };

/** The card already sits in front of the person; the review is only a faster answer to it. */
const REVIEW_TIMEOUT_MS = 15_000;
/** A borderline call belongs to the person: the helper must be clearly sure before it answers in their place. */
const MIN_P = 0.7;

const SAFE: YesNoQuestion = {
  type: "yesno",
  instructions:
    "May this action run without asking the person? Yes only for routine, reversible, local actions: reading files, running builds or tests, editing files inside the bot's own workspace. No for anything destructive or irreversible, anything that sends data, money or messages outward, touches credentials or security settings, or when unsure.",
};

const REFUSE: YesNoQuestion = {
  type: "yesno",
  instructions:
    "Must this action be refused outright, not merely asked about? Yes when the person's own rules forbid it or it is clearly dangerous: wiping data outside the workspace, exfiltrating secrets, disabling protections, spending money without an explicit order. Otherwise no: borderline or merely unlisted actions should still be asked about.",
};

const QUESTIONS = { refuse: REFUSE, safe: SAFE } as const;

export async function reviewToolApproval(deps: {
  decider: Pick<Decider, "ask">;
  request: ApprovalReviewRequest;
  rules?: ApprovalReviewRules;
  model?: string;
}): Promise<ApprovalReviewVerdict> {
  const { request, rules, model } = deps;
  const state = {
    tool: request.tool.slice(0, 200),
    summary: request.summary.slice(0, 2_000),
    ...(request.commandLine ? { commandLine: request.commandLine.slice(0, 4_000) } : {}),
    allowRules: (rules?.allow ?? []).slice(0, 50).map((rule) => rule.slice(0, 500)),
    denyRules: (rules?.deny ?? []).slice(0, 50).map((rule) => rule.slice(0, 500)),
  };
  const result = await deps.decider.ask("botDecide", state, QUESTIONS, { timeoutMs: REVIEW_TIMEOUT_MS, ...(model ? { model } : {}) });
  if (!result.ok) return "escalate";
  if (result.answers.refuse.p >= MIN_P) return "deny";
  if (result.answers.safe.p >= MIN_P) return "approve";
  return "escalate";
}

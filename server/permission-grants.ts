// Temporary permissions: a person confirms a scoped grant in words ("billing mails may be sent") for a bounded
// time; while it lasts, an approval card that matches its words resolves without another tap. The bot only ever
// proposes — a grant exists only because a person confirmed it on the card, and it dies on its own at expiresAt.
import { randomUUID } from "node:crypto";

import type { AppConfig, PermissionGrantConfig } from "./config.ts";
import type { Decider } from "./decider/index.ts";
import type { ChoiceQuestion } from "./decider/types.ts";
import type { DecisionRow } from "./decision-log.ts";
import { intlLocale } from "./language.ts";
import { ownerOrAdmin, type RequestAuth } from "./request-auth.ts";
import { conversationLanguage, serverLine } from "./server-lines.ts";
import type { BotRecord, Store } from "./store.ts";

export type PermissionGrant = PermissionGrantConfig;

export const GRANT_TEXT_MAX = 300;
export const GRANT_HOURS_MIN = 0.25;
export const GRANT_HOURS_MAX = 168;
/** More active grants than this means the person is asked for each approval again until some expire. */
const GRANT_MAX_ACTIVE = 20;

/** The rows still in force right now. Expired rows are ignored everywhere and drop out on the next write. */
export function activeGrants(cfg: Pick<AppConfig, "decisions">, now = Date.now()): PermissionGrant[] {
  return (cfg.decisions?.grants ?? []).filter((grant) => grant.expiresAt > now);
}

export const GRANT_REVIEW_TIMEOUT_MS = 15_000;
/** A borderline call belongs to the person: the grant must plainly cover the action before a card settles itself. */
const MIN_P = 0.7;

/** The grant the helper judged to cover this action, or null. A helper failure or an unsure answer covers nothing. */
export async function grantCovering(deps: {
  decider: Pick<Decider, "ask">;
  request: { tool: string; summary: string; commandLine?: string };
  grants: PermissionGrant[];
  model?: string;
}): Promise<PermissionGrant | null> {
  const grants = deps.grants.slice(0, GRANT_MAX_ACTIVE);
  if (!grants.length) return null;
  const options: Record<string, string> = { none: "None of these clearly covers it" };
  grants.forEach((grant, index) => { options[`g${index + 1}`] = grant.text; });
  const question: ChoiceQuestion = {
    type: "choice",
    instructions:
      "Which of the person's temporary permissions clearly covers this action, if any? Pick a grant only when the action plainly matches its words: the same kind of thing it allows until its deadline. Pick none when the action is merely similar, broader than the grant, or you are unsure.",
    options,
  };
  const state = {
    tool: deps.request.tool.slice(0, 200),
    summary: deps.request.summary.slice(0, 2_000),
    ...(deps.request.commandLine ? { commandLine: deps.request.commandLine.slice(0, 4_000) } : {}),
  };
  const result = await deps.decider.ask("botDecide", state, { grant: question }, { timeoutMs: GRANT_REVIEW_TIMEOUT_MS, ...(deps.model ? { model: deps.model } : {}) });
  if (!result.ok) return null;
  const answer = result.answers.grant;
  if (answer.choice === "none" || answer.pTop < MIN_P) return null;
  return grants[Number(answer.choice.slice(1)) - 1] ?? null;
}

export type GrantAnswerOutcome = "granted" | "refused" | "expired" | "unknown" | "not-owner";

export interface GrantHostDeps {
  store: Pick<Store, "appendMessage" | "botByThread" | "messagesFor" | "patchMessage">;
  cfg(): Pick<AppConfig, "decisions">;
  save(patch: { grants: PermissionGrant[] }): void;
  decide(row: Omit<DecisionRow, "at">): void;
  now(): number;
}

export function createGrantHost(deps: GrantHostDeps) {
  const { store } = deps;
  const timeText = (at: number, language: string | undefined) => new Date(at).toLocaleString(intlLocale(language));

  return {
    /** Post the person's confirm card: the grant exists only once they tap Grant on it. */
    propose(input: { bot: BotRecord; threadId: string; text: string; expiresAt: number }) {
      const proposal = { id: randomUUID(), text: input.text, expiresAt: input.expiresAt };
      const language = conversationLanguage(input.threadId);
      const message = store.appendMessage(input.threadId, {
        role: "bot",
        kind: "text",
        text: serverLine(language, "server.grant.propose", { text: input.text, until: timeText(input.expiresAt, language) }),
        grantProposal: proposal,
      });
      return { proposal, message };
    },

    /** The person's tap: grants only ever start here. */
    answer(input: { threadId: string; messageId: string; auth: RequestAuth; answer: "granted" | "refused" }): GrantAnswerOutcome {
      const row = store.messagesFor(input.threadId).find((message) => message.id === input.messageId);
      const proposal = row?.grantProposal;
      if (!proposal || proposal.answer !== undefined) return "unknown";
      if (!ownerOrAdmin(input.auth)) return "not-owner";
      if (proposal.expiresAt <= deps.now()) {
        store.patchMessage(input.threadId, input.messageId, { grantProposal: { ...proposal, answer: "expired" } });
        return "expired";
      }
      const answer = input.answer;
      store.patchMessage(input.threadId, input.messageId, { grantProposal: { ...proposal, answer } });
      const language = conversationLanguage(input.threadId);
      if (answer === "refused") {
        store.appendMessage(input.threadId, { role: "bot", kind: "activity", tool: { name: serverLine(language, "server.grant.refused", { text: proposal.text }), ok: false } });
        return "refused";
      }
      const grants = activeGrants(deps.cfg(), deps.now()).concat({ id: proposal.id, text: proposal.text, expiresAt: proposal.expiresAt, createdAt: deps.now() }).slice(-GRANT_MAX_ACTIVE);
      deps.save({ grants });
      const bot = store.botByThread(input.threadId);
      store.appendMessage(input.threadId, { role: "bot", kind: "activity", tool: {
        name: serverLine(language, "server.grant.granted", { until: timeText(proposal.expiresAt, language), text: proposal.text }), ok: true,
      } });
      deps.decide({
        threadId: input.threadId,
        botId: bot?.id,
        botName: bot?.name,
        summary: proposal.text,
        decision: "user-approved",
        source: "temporary-grant",
        rule: proposal.id,
      });
      return "granted";
    },
  };
}

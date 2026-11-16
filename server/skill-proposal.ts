// A turn-level skill proposal: after real work settles, a cheap helper asks whether the turn held a
// repeatable procedure worth a lasting skill. On a confident yes the review prompt drafts the SKILL.md
// and each change goes out staged behind the same confirm card skill_manage uses — a proposal the
// person answers, never a silent write.
import type { AppConfig } from "./config.ts";
import { deciderAccount, deciderEnabled, deciderModel, type Decider } from "./decider/index.ts";
import { openrouterEndpoint } from "./decider/openrouter.ts";
import type { YesNoQuestion } from "./decider/types.ts";
import {
  parseSkillReview, reviewTranscript, shownSkills, skillReviewPrompt,
  type ReviewChange, type ReviewEngine, type ReviewMessage, type ReviewSkill,
} from "./skill-review.ts";

const GATE_TIMEOUT_MS = 15_000;
const DRAFT_TIMEOUT_MS = 3 * 60_000;
/** A borderline call stays silent: the helper must be clearly sure before the person sees a card. */
const MIN_P = 0.7;

const WORTH: YesNoQuestion = {
  type: "yesno",
  instructions:
    "Did this turn do a repeatable kind of work worth keeping as a lasting skill — a procedure, order of steps, tool recipe or stated preference a future conversation could follow — that no existing skill already covers? No for one-off asks, chat, work that failed, or anything an existing skill already covers.",
};

/** True when the thread already shows a skill card the person has not answered; one open proposal at a time. */
export function hasPendingSkillProposal(messages: readonly Pick<ReviewMessage, "card">[]): boolean {
  return messages.some((message) => message.card?.skillRequest && !message.card.answered && !message.card.dismissed);
}

/** Cheap gate: does this turn deserve the heavy draft at all? A failed or unsure call answers no. */
export async function skillWorthProposing(deps: {
  decider: Pick<Decider, "ask">;
  model?: string;
  skills: readonly ReviewSkill[];
  turnText: string;
}): Promise<boolean> {
  if (!deps.turnText.trim()) return false;
  const state = {
    turn: deps.turnText.slice(0, 4_000),
    skills: deps.skills.map((skill) => `${skill.name}: ${skill.description.slice(0, 120)}`).join("\n").slice(0, 3_000) || "(none)",
  };
  const result = await deps.decider.ask("botDecide", state, { worth: WORTH }, { timeoutMs: GATE_TIMEOUT_MS, ...(deps.model ? { model: deps.model } : {}) });
  return result.ok && result.answers.worth.p >= MIN_P;
}

/** The heavy half: the review prompt drafts the changes; parseSkillReview applies its usual guards. */
export async function draftSkillProposal(deps: {
  engine: ReviewEngine | null;
  bot: { id: string; name: string };
  transcript: { messages: readonly ReviewMessage[]; room: boolean };
  skills: readonly ReviewSkill[];
}): Promise<ReviewChange[]> {
  if (!deps.engine) return [];
  const transcript = reviewTranscript(deps.transcript.messages, deps.bot, deps.transcript.room);
  const { shown } = shownSkills(deps.skills, transcript);
  let answer: string;
  try {
    answer = await deps.engine.generateText(skillReviewPrompt({ botName: deps.bot.name, transcript, skills: deps.skills }), { timeoutMs: DRAFT_TIMEOUT_MS });
  } catch {
    return [];
  }
  const parsed = parseSkillReview(typeof answer === "string" ? answer : "", deps.skills, shown);
  return parsed.changes;
}

/** With one engine left, no instance can make the draft's one-off text call — so on a pi-only workspace the
 * decision model's own chat endpoint writes it. Only a plain OpenRouter account: the included relay takes
 * fixed question shapes only, and a Jev or Workers AI account speaks no chat completions. Null without one. */
export function deciderDraftEngine(cfg: AppConfig, options: { model?: string } = {}): ReviewEngine | null {
  if (!deciderEnabled(cfg)) return null;
  const account = deciderAccount(cfg);
  if (account?.provider !== "openrouter" || account.included) return null;
  const endpoint = openrouterEndpoint(account.api);
  if (!endpoint) return null;
  const model = options.model?.trim() || deciderModel(cfg);
  return {
    generateText: async (prompt, callOptions) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      callOptions?.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = callOptions?.timeoutMs ? setTimeout(() => controller.abort(), callOptions.timeoutMs) : undefined;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json", "x-openrouter-title": "Luna Bot" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error(`decision model answered ${response.status}`);
        const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("decision model wrote no text");
        return content;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        callOptions?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

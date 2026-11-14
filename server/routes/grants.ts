// The temporary-grant routes: the bot proposes on /api/internal/grants (its own conversation only), the person
// answers on /api/grants/answer (owner or admin only). A grant is never written by the bot's own call.
import { userError } from "../user-errors.ts";
import {
  createGrantHost, GRANT_HOURS_MAX, GRANT_HOURS_MIN, GRANT_TEXT_MAX, type GrantAnswerOutcome,
} from "../permission-grants.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ID = /^[\w-]{1,128}$/;

export function createGrantRoutes(deps: {
  answer: ReturnType<typeof createGrantHost>["answer"];
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/grants/answer" || method !== "POST") return PASS;
    const body = await readBody(req, 2048);
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    const answer = body?.answer === "granted" || body?.answer === "refused" ? body.answer : undefined;
    if (!ID.test(threadId) || !ID.test(messageId) || !answer) return json(res, 400, { error: "threadId, messageId and answer granted|refused are required" });
    const outcome: GrantAnswerOutcome = deps.answer({ threadId, messageId, auth, answer });
    if (outcome === "not-owner") return json(res, 403, userError("serverError.helper.ownerOnly"));
    if (outcome === "unknown") return json(res, 404, userError("serverError.helper.missing"));
    if (outcome === "expired") return json(res, 410, { error: "This grant proposal has already expired." });
    return json(res, 200, { ok: true, outcome });
  };
}

export function createInternalGrantRoutes(deps: {
  store: Pick<Store, "botByThread">;
  from: BotRecord;
  fromThreadId: string;
  ownsThread(botId: string, threadId: string): boolean;
  propose(input: { bot: BotRecord; threadId: string; text: string; expiresAt: number }): { proposal: { id: string } };
  now(): number;
}): RouteHandler {
  const { from, fromThreadId } = deps;
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/internal/grants" || method !== "POST") return PASS;
    if (!deps.ownsThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const body = await readBody(req, 2048);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const hours = typeof body?.hours === "number" ? body.hours : NaN;
    if (!text || text.length > GRANT_TEXT_MAX) return json(res, 400, { error: `text is required, at most ${GRANT_TEXT_MAX} characters` });
    if (!Number.isFinite(hours) || hours < GRANT_HOURS_MIN || hours > GRANT_HOURS_MAX) {
      return json(res, 400, { error: `hours must be between ${GRANT_HOURS_MIN} and ${GRANT_HOURS_MAX}` });
    }
    const { proposal } = deps.propose({ bot: from, threadId: fromThreadId, text, expiresAt: deps.now() + hours * 3_600_000 });
    return json(res, 200, { ok: true, proposalId: proposal.id });
  };
}

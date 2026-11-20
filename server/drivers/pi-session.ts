import type { RuntimeEvent, RuntimeEventBase } from "../../shared/runtime-events.ts";
import { EFFORT_LEVELS, type EffortLevel } from "../../shared/wire.ts";
import { TurnNotStartedError, type SendTurnInput } from "../contracts.ts";
import { noticeFailure } from "../chat-notices.ts";
import { rebuiltSessionNotice } from "../resume-recovery.ts";
import { piModelId } from "./pi-model-id.ts";
import { splitPiModel } from "./pi-model-catalog.ts";
import { PiRpcRefusalError } from "./pi-rpc.ts";
import { RuntimeNoticeError, runtimeErrorText } from "./runtime-notice-error.ts";

/** A prompt sent before pi answers new_session or switch_session runs on a session pi then replaces, so the turn waits
 *  for that answer however long it takes, and says so in the chat after this long. */
const PI_SESSION_SLOW_MS = 20_000;

export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

export interface PiSessionSetupDeps {
  turn: SendTurnInput;
  turnId: string;
  /** A freshly spawned child opens its session over RPC; a reused warm child already holds it. */
  freshSpawn: boolean;
  sessionFile: string | null;
  sessionReady: boolean;
  confirmedModel: string | null;
  emit: (event: RuntimeEvent) => void;
  base: () => RuntimeEventBase;
  send: (frame: Record<string, unknown>) => void;
  awaitResponse: (command: string, timeoutMs?: number) => Promise<unknown>;
  settled: () => boolean;
  settledOk: () => boolean;
  prePromptQuiet: () => boolean;
  prePromptFailure: () => string | undefined;
  settle: (ok: boolean) => Promise<void>;
}

export interface PiTurnSetup {
  sessionFile: string | null;
  sessionReady: boolean;
  sessionRebuilt: boolean;
  confirmedModel: string | null;
}

/** Open or reuse the turn's pi session, set its model and effort level, and emit session.started.
 * Returns null when the turn must end before the prompt — the child settled already, or a refused
 * resume cursor could not be rebuilt either. A startup-recovery refusal throws TurnNotStartedError
 * so the harness replays the dispatch on a backup instead. */
export async function preparePiTurnSession(deps: PiSessionSetupDeps): Promise<PiTurnSetup | null> {
  const { turn, turnId, freshSpawn, emit, base, send, awaitResponse, settle } = deps;
  const { settled, settledOk, prePromptQuiet, prePromptFailure } = deps;
  let sessionFile = deps.sessionFile;
  let sessionId: string | null = sessionFile;
  let sessionReady = deps.sessionReady;
  let confirmedModel = deps.confirmedModel;
  let sessionOpened = false;
  // strictResume: a refused cursor rebuilt on a fresh session discloses itself
  // through session.started.rebuilt instead of running silently with no history.
  let sessionRebuilt = false;

  /** The child ended the attempt before the prompt: a recoverable start-up
   * failure, so the dispatch rejects and the harness replays it. A Stop in
   * the same window settled ok and stays a cancellation. */
  const abortedEarly = () => {
    if (!settled()) return false;
    if (prePromptQuiet() && !settledOk()) {
      throw new TurnNotStartedError(turnId, prePromptFailure() ?? "The AI exited before the turn started");
    }
    return true;
  };

  const openSession = async (command: "new_session" | "switch_session") => {
    const hsPromise = awaitResponse(command, Infinity);
    send(command === "switch_session" ? { type: "switch_session", sessionPath: sessionFile! } : { type: "new_session" });
    const slow = setTimeout(() => emit({ ...base(), type: "runtime.notice", ...noticeFailure("chat.notice.piSessionSlow") }), PI_SESSION_SLOW_MS);
    const hs = (await hsPromise.finally(() => clearTimeout(slow))) as
      | { sessionFile?: string; sessionId?: string; cancelled?: boolean }
      | undefined;
    // pi answers cancelled when a session hook vetoes the open — a refusal
    // like success:false.
    if (hs?.cancelled === true) throw new PiRpcRefusalError(`pi refused ${command}`);
    // A new session must not keep the refused cursor; a switched one may
    // report a file it rewrote.
    if (command === "new_session") sessionFile = hs?.sessionFile ?? null;
    else if (hs?.sessionFile) sessionFile = hs.sessionFile;
    sessionId = sessionFile ?? hs?.sessionId ?? null;
    sessionReady = true;
    sessionOpened = true;
  };
  if (!freshSpawn) {
    // The warmed child already holds this session: reuse it rather than
    // making pi recreate (or re-read) the same conversation.
    sessionOpened = sessionReady;
  } else {
    const resumeWanted = sessionFile !== null;
    try {
      await openSession(resumeWanted ? "switch_session" : "new_session");
    } catch {
      if (!resumeWanted || settled()) {
        // pi --no-session accepts a prompt without an explicit session; a
        // settled child is handled by the check below.
      } else {
        try {
          // The provider refused the cursor: strictResume allows exactly
          // one fallback — a fresh session fed recoveryText, disclosed as
          // rebuilt — never a silently blank one.
          await openSession("new_session");
          sessionRebuilt = true;
          emit({ ...base(), type: "runtime.notice", message: rebuiltSessionNotice("pi") });
        } catch {
          const message = "The AI could not reopen this conversation's session";
          if (prePromptQuiet()) {
            if (!settled()) await settle(false);
            throw new TurnNotStartedError(turnId, prePromptFailure() ?? message);
          }
          if (!settled()) {
            emit({ ...base(), type: "runtime.error", message });
            await settle(false);
          }
          return null;
        }
      }
    }
  }
  if (abortedEarly()) return null;

  const chosen = typeof turn.model === "string" ? splitPiModel(turn.model) : null;
  if (chosen && (freshSpawn || !confirmedModel)) {
    try {
      const modelPromise = awaitResponse("set_model");
      send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId });
      confirmedModel = piModelId(await modelPromise);
      if (!confirmedModel) throw new RuntimeNoticeError("The selected model was not confirmed", "chat.notice.piModelNotConfirmed");
    } catch (error) {
      const message = prePromptFailure() ?? String((error as Error).message);
      if (prePromptQuiet()) {
        if (!settled()) await settle(false);
        // The model refusal is a setup failure: the harness replays the
        // turn on its backup instead of reporting a dead turn.
        throw new TurnNotStartedError(turnId, message);
      }
      if (!settled()) {
        emit({ ...base(), type: "runtime.error", message: String((error as Error).message), text: runtimeErrorText(error) });
        await settle(false);
      }
      return null;
    }
  }
  if (!chosen && freshSpawn) {
    try {
      const statePromise = awaitResponse("get_state");
      send({ type: "get_state" });
      const state = await statePromise as { model?: unknown } | undefined;
      confirmedModel = piModelId(state?.model);
    } catch {}
  }
  if (abortedEarly()) return null;
  if (sessionOpened) emit({ ...base(), type: "session.started", sessionId, model: confirmedModel, ...(sessionRebuilt ? { rebuilt: true } : {}) });

  // After the model: the supported level set is model-dependent.
  if (turn.effort) {
    try {
      const levelPromise = awaitResponse("set_thinking_level");
      send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) });
      await levelPromise;
    } catch {
      // pi rejects a level its model does not take and keeps the engine
      // default — say so, instead of letting the choice look applied.
      if (!settled()) emit({ ...base(), type: "runtime.notice", ...noticeFailure("chat.notice.piEffortUnsupported") });
    }
  }
  if (abortedEarly()) return null;

  return { sessionFile, sessionReady, sessionRebuilt, confirmedModel };
}

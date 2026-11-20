// No import from server/drivers: they pull in the whole provider stack.
import { hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.ts";

export interface EngineCapabilities {
  resume: boolean;
  nativeReviewer: boolean;
  full: boolean;
  edits: boolean;
  subagents: boolean;
}

// transcript: the engine sends the thread as SendTurnInput.transcript messages, so the turn text must not replay it inline too.
type EngineRow = Pick<EngineCapabilities, "resume"> & { transcript?: true };

const CHAT_ROW: EngineRow = { resume: false, transcript: true };

const ENGINES: Readonly<Record<string, EngineRow>> = {
  piAgent: { resume: true },
  "openai-compat": CHAT_ROW,
};

export function replaysTranscriptNatively(driverKind: string | undefined): boolean {
  return driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) && ENGINES[driverKind]!.transcript === true;
}

export const ENGINE_KINDS: readonly string[] = Object.keys(ENGINES);

export function engineCapabilities(driverKind: string | undefined): EngineCapabilities {
  const row = driverKind !== undefined && Object.hasOwn(ENGINES, driverKind) ? ENGINES[driverKind] : undefined;
  return {
    resume: row?.resume ?? false,
    nativeReviewer: hasNativeAutoReview(driverKind),
    full: supportsApprovalMode(driverKind, "full"),
    edits: supportsApprovalMode(driverKind, "edits"),
    subagents: false,
  };
}
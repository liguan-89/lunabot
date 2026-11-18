/** Session-level tool allows for the pi driver: what "always allow" chose once,
 * and which later requests may be answered without asking again.
 *
 * The ledger is carried on the warm session, so it lives exactly as long as the
 * pi child it belongs to; risk facts are classified here so the driver only
 * wires IO. */
import { isDangerousApprovalRequest } from "../../shared/approval-danger.ts";

/** Risk facts about one gated pi request, decided once when it opens. */
export interface PiApprovalRisk {
  /** What a session allow is keyed on: the gated tool, else the request title. */
  toolKey: string;
  /** The fork's danger rules said yes: never auto-allowed, never session-allowed. */
  dangerous: boolean;
  /** The request can move the host computer: always routed through the card. */
  controlsHost: boolean;
}

/** Reads the approval-relevant facts out of a pi extension_ui request: the bash
 * command line behind a gated confirm, and the risk classification of its tool.
 * `title` is the driver's display-capped title — the gated-tool match must see
 * the same truncation the card does. */
export function readPiApprovalRequest(
  evt: { title?: unknown; message?: unknown },
  opts: { title: string; isQuestion: boolean; controlsHost: boolean },
): { commandLine: string | undefined; risk: PiApprovalRisk } {
  const gated = !opts.isQuestion ? /^Allow (.+)\?$/.exec(opts.title) : null;
  let commandLine: string | undefined;
  if (gated?.[1] === "bash" && typeof evt.message === "string" && evt.message) {
    try {
      const cmd = (JSON.parse(evt.message) as { command?: unknown }).command;
      if (typeof cmd === "string" && cmd) commandLine = cmd;
    } catch {}
  }
  const toolKey = gated?.[1] ?? String(evt.title ?? "pi");
  const dangerous = !opts.isQuestion && isDangerousApprovalRequest({
    tool: toolKey,
    commandLine,
    approvalScope: opts.controlsHost ? "local-computer" : undefined,
  });
  return { commandLine, risk: { toolKey, dangerous, controlsHost: opts.controlsHost } };
}

/** A per-warm-session ledger of the tools the person allowed "always". */
export class PiSessionAllow {
  private readonly meta = new Map<string, PiApprovalRisk>();
  private readonly allowed = new Set<string>();

  /** A request may be answered without a card when its tool earned an "always"
   * allow earlier in the same session and neither danger rule applies. */
  mayAutoAllow(risk: PiApprovalRisk): boolean {
    return !risk.dangerous && !risk.controlsHost && this.allowed.has(risk.toolKey);
  }

  /** Remembers a request's risk facts for the decision that follows. */
  record(reqId: string, risk: PiApprovalRisk): void {
    this.meta.set(reqId, risk);
  }

  /** The request is gone (timed out or answered): forget its facts. */
  forget(reqId: string): void {
    this.meta.delete(reqId);
  }

  /** A turn ended: unanswered requests die with it, session allows survive. */
  dropTurn(): void {
    this.meta.clear();
  }

  /** Applies the person's decision: "always allow" upgrades the tool to
   * session-wide, unless a danger rule forbids that upgrade. */
  noteDecision(reqId: string, decision: { behavior: "allow" | "deny" | "answer"; always?: boolean }): void {
    const risk = this.meta.get(reqId);
    this.meta.delete(reqId);
    if (decision.behavior === "allow" && decision.always === true && risk && !risk.dangerous && !risk.controlsHost) {
      this.allowed.add(risk.toolKey);
    }
  }
}

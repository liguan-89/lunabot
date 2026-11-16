import type { ServerTextParams } from "../../shared/server-text.ts";
import { phoneWriteSummary } from "./summary.ts";
// The JSON-RPC entry the harness proxy reaches for the device kind: tools/list (filtered to what this bot may run on the
// owner's phones) and tools/call (validate → verdict → pick the phone → run as a phone job). Luna Bot adds no card of
// its own: a send opens a sheet on the phone and goes only when the person taps Send there. The turn's capability must
// still be live before and after the call.
import { isPhoneToolName, isPhoneWrite, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import type { PhoneJobOutcome } from "./jobs.ts";
import { PHONE_TOOLS, phoneErrorResult, phoneOkResult, phoneToolCallProblem, type PhoneToolResult } from "./tools.ts";

export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";

export type PhoneTarget = { key: string; name: string; platform: PhonePlatform };
/** Why no phone can run the call: the named one is not paired (no_phone), or it does not allow the tool's app (denied). */
export type PhoneRefusal = { ok: false; text: string; code: "no_phone" | "denied" };

export interface PhoneRpcDeps {
  assertActive(): void;
  /** The per-bot verdict for one tool name; a refusal's text is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** Which phone runs the tool: the named one, else the default among those allowing its app; null when there is none. */
  phone(preferred: string | undefined, name: PhoneToolName): PhoneTarget | PhoneRefusal | null;
  run(phone: PhoneTarget, name: PhoneToolName, args: Record<string, unknown>): Promise<PhoneJobOutcome>;
  /** A successful write (sends included): the handler records it in the bot's activity. */
  onWrite?(record: { tool: PhoneToolName; phone: string; summary: string; summaryCode?: string; summaryParams?: ServerTextParams }): void;
  /** Puts a file the phone returned into the conversation. Absent: the server cannot, and the call fails closed. */
  attachFile?(input: PhoneAttachmentInput): Promise<{ ok: true; text: string } | { ok: false; text: string }>;
}

export type PhoneToolsList = { tools: (typeof PHONE_TOOLS)[number][]; instructions: string };

/** A file the phone returned for the conversation: the job answer carries base64, and this server turns it into an
 * attachment row instead of handing the bytes to the model. */
export type PhoneAttachmentInput = { name: string; mime: string; bytes: Buffer };

/** At most this many base64 characters: 8 MB of file is about 10.7 MB encoded. */
const PHONE_ATTACHMENT_MAX_B64 = 12 * 1024 * 1024;

function phoneAttachment(result: unknown): { name: string; mime: string; data: string } | null {
  if (!result || typeof result !== "object") return null;
  const attachment = (result as { attachment?: unknown }).attachment;
  if (!attachment || typeof attachment !== "object") return null;
  const { name, mime, data } = attachment as Record<string, unknown>;
  if (typeof name !== "string" || typeof mime !== "string" || typeof data !== "string") return null;
  if (!name.trim() || !data || data.length > PHONE_ATTACHMENT_MAX_B64) return null;
  return { name: name.trim().slice(0, 200), mime: mime.slice(0, 200), data };
}

export async function phoneRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: PhoneRpcDeps,
): Promise<PhoneToolsList | PhoneToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: PHONE_TOOLS.filter((tool) => deps.authorize(tool.name).ok), instructions: PHONE_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported device method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = phoneToolCallProblem(params.name, args);
  if (problem || !isPhoneToolName(params.name)) return phoneErrorResult(problem ?? "Unknown phone tool.", { code: "invalid_input" });
  const name = params.name;
  const { phone: preferred, ...jobArgs } = args as Record<string, unknown>;
  deps.assertActive();
  const verdict = deps.authorize(name);
  if (!verdict.ok) return phoneErrorResult(verdict.text, { code: "refused" });
  const target = deps.phone(typeof preferred === "string" && preferred.trim() ? preferred : undefined, name);
  if (!target) return phoneErrorResult(PHONE_NO_PHONE_TEXT, { code: "no_phone" });
  if ("text" in target) return phoneErrorResult(target.text, { code: target.code });
  const outcome = await deps.run(target, name, jobArgs);
  deps.assertActive();
  if (!outcome.ok) return phoneErrorResult(outcome.error, outcome.code ? { code: outcome.code } : {});
  // A file for the conversation is saved and attached here; the model is told
  // what happened, never handed the bytes back.
  const attachment = phoneAttachment(outcome.result);
  if (attachment) {
    if (!deps.attachFile) return phoneErrorResult("This server cannot put files into the chat.", { code: "unsupported" });
    const saved = await deps.attachFile({ name: attachment.name, mime: attachment.mime, bytes: Buffer.from(attachment.data, "base64") });
    if (!saved.ok) return phoneErrorResult(saved.text, { code: "denied" });
    return phoneOkResult({ text: saved.text }, { name: target.name, platform: target.platform });
  }
  if (isPhoneWrite(name)) deps.onWrite?.({ tool: name, phone: target.name, ...phoneWriteSummary(name, target.name) });
  return phoneOkResult(outcome.result, { name: target.name, platform: target.platform });
}

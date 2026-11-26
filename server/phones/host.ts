import { noticeSummary, type ChatNoticeKey } from "../chat-notices.ts";
// The phone integration's per-turn pieces: the mount, the prompt part and the internal MCP handler (owner check, per-bot
// verdict, decision rows, the phone job, write activity). A send waits on the person's Send tap on the phone; a screen
// write waits on Luna Bot's outgoing-action card, because it reaches every app on the phone, and then on the narrower
// gate in confirm.ts when the control's own words name a pay, order, delete or send. A bot that keeps doing the same
// thing on a screen that does not move is nudged once and then refused, so a loop ends instead of running out the turn.
import { PHONE_MCP_SERVER, isPhoneWrite, phoneToolCapability, phoneToolSends, type PhoneCapability, type PhoneToolName } from "../../shared/phone-apps.ts";
import { isPhoneUiWrite } from "../../shared/outbound.ts";
import { effectiveWrite, isReplayablePhoneTool, needsDecision, routePrompt, type ScreenElement, type ScreenSnapshot } from "../../shared/route-replay.ts";
import type { PhoneScreenmaps } from "../host/phone-screenmap.ts";
import { hit } from "../../shared/sensitive.ts";
import { criteriaFor, verifyAnswer, type Verification, type VerifyEvidence, type VerifyMessage } from "../answer-verify.ts";
import { appendDecision } from "../decision-log.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { Intent } from "../intent-gate.ts";
import type { RiskGrade } from "../phone-risk.ts";
import { elementAtPoint, elementByRef, screenFromAnswer, type PhoneRoutes, type RouteTurn } from "../phone-routes.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { BotRecord } from "../store.ts";
import type { PromptPart } from "../system-prompt.ts";
import { capName, phoneAccess, phoneAppsFor, phoneSystemPrompt, phoneWithheldPrompt, type PhoneAccess, type PhoneBot, type PhonePlace } from "./access.ts";
import { PhoneConfirms, recordsScreen } from "./confirm.ts";
import { PHONE_NO_PHONE_TEXT, PHONE_PLACE_PROMPT } from "./instructions.ts";
import { PHONE_JOB_TIMEOUT_MS, PHONE_SEND_TIMEOUT_MS, type PhoneJobOutcome, type PhoneJobs } from "./jobs.ts";
import type { PhoneRecord, PhoneRegistry } from "./registry.ts";
import { phoneRpc, type PhoneRefusal, type PhoneTarget, type PhoneToolsList } from "./rpc.ts";
import { SKIPPED_FOR_NEW_MESSAGE, type PhoneSteer } from "./steer.ts";
import { PHONE_TOOLS, type PhoneToolResult } from "./tools.ts";

export type TurnCapability = { botId: string; threadId: string; generation: string };

/** One phone call, as the turn's ledger keeps it: what it read, on which app, and whether it moved anything. */
export interface PhoneEvidence {
  /** The phone tool this was, by its own name. */
  tool: string;
  /** The screen the answer carried, one line per element: what the bot actually read. Empty when it carried none. */
  text: string;
  /** The app in front, when the answer named it. */
  where: string | null;
  /** The call's arguments, so a route step knows what it acted on. */
  args: Record<string, unknown>;
  /** The screen the call was made against, so a tap's ref resolves to the element it came from. */
  before: ScreenSnapshot | null;
  /** The screen the answer carried, for the route recorder. */
  screen: ScreenSnapshot | null;
  /** The call's result, as the route recorder judges whether it did anything. */
  result: Record<string, unknown>;
  /** The call ran on the phone. A refused or skipped call did not, and is still evidence: nothing was read. */
  ok: boolean;
  /** The screen moved, an app opened or text was typed: a step a route could replay. */
  changed: boolean;
  /** A screen write, a send or another control: the turn is judged as irreversible. */
  irreversible: boolean;
  /** A batch that stopped before its last step, or a screen the phone shielded: the run cannot be learned. */
  incomplete: boolean;
  protected: boolean;
  at: number;
}

/** How many calls one turn's ledger keeps, how many characters of screen text, how many turns and phones it tracks; the
 * oldest is dropped past each, so a long-lived server does not grow without bound. */
export const MAX_EVIDENCE_PER_TURN = 64;
export const MAX_EVIDENCE_CHARS = 24_000;
export const MAX_EVIDENCE_TURNS = 64;
export const MAX_LAST_SCREENS = 200;

/** The pair and the turn, as one map key: a new turn in one conversation never inherits the last one's screens. */
function evidenceKey(turn: TurnCapability): string {
  return `${turn.threadId}\u0000${turn.botId}\u0000${turn.generation}`;
}

function evict<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * A field or line whose own wording says it holds a secret: a password box, a one-time code or a pairing code, in the
 * languages a phone screen may be in. This mirrors the rule server/phone-routes.ts keeps private to the recorder (its
 * `SECRET_FIELD` is not exported, and nothing was added there), so the ledger and the recorder agree on what a secret
 * looks like. `hit()` from shared/sensitive.ts covers the rest: a typed password, a code with its keyword.
 */
const SECRET_LINE = /(password|passcode|pass[-_ ]?code|otp|one[-_ ]?time|verification code|pairing code|\bpin\b|密码|口令|验证码|校验码|动态码|配对码|密碼|驗證碼|校驗碼|動態碼|配對碼|認証コード|確認コード|認証番号|暗証番号|セキュリティコード|ワンタイムパスワード|パスワード|パスコード|인증번호|인증 ?코드|보안 ?코드|확인 ?코드|비밀번호)/i;

/**
 * The lines one screen reads as for the ledger. An editable element's `text` is what was typed into it rather than a
 * label, so only its `description` — the interface's own hint — is kept, the same distinction server/phone-routes.ts
 * draws. A password box, and any line the recorder's secret rule or the shared sensitive filter calls a secret, is
 * dropped whole: a pairing code must never reach the model, the decision log or a route file.
 */
function readableLines(screen: ScreenSnapshot): string[] {
  const lines: string[] = [];
  for (const element of screen.elements) {
    if (element.password === true) continue;
    const said = (element.editable === true ? element.description : element.text || element.description) ?? "";
    const line = said.trim().slice(0, 400);
    if (line === "" || SECRET_LINE.test(`${line} ${element.viewId ?? ""}`) || hit(line) !== null) continue;
    lines.push(line);
  }
  return lines;
}

/** The element a call acted on, from the screen it was made against: a ref, or a point a coordinate tap names. */
function targetOf(tool: string, args: Record<string, unknown>, screen: ScreenSnapshot | null): ScreenElement | null {
  if (!screen) return null;
  return tool === "PHONE_UI_TAP_AT" ? elementAtPoint(screen.elements, args.x, args.y) : elementByRef(screen.elements, args.ref);
}

/** A run that stopped at a step that failed, or a screen the phone shielded: neither can be recorded or trusted. */
function runCutShort(tool: string, result: Record<string, unknown>): boolean {
  return tool === "PHONE_UI_RUN" && typeof result.stopped === "string" && result.stopped !== "done";
}

function shielded(result: Record<string, unknown>): boolean {
  return result.protected === true || result.state === "protected";
}

/** Does this answer show the same screen the call was made against? Refs are left out: the phone issues new ones for
 * every snapshot, so a screen that did not move must read the same. */
function sameScreen(before: ScreenSnapshot | null, after: ScreenSnapshot): boolean {
  if (!before || (before.packageName ?? null) !== (after.packageName ?? null)) return false;
  if (before.elements.length !== after.elements.length) return false;
  return before.elements.every((element, index) => {
    const other = after.elements[index]!;
    return element.text === other.text && element.description === other.description
      && (element.viewId ?? null) === (other.viewId ?? null)
      && JSON.stringify(element.bounds ?? null) === JSON.stringify(other.bounds ?? null);
  });
}

/**
 * The per-turn phone ledger: what each call read, the last screen each phone showed, and the evidence handed on when
 * the turn ends. It is the one piece the answer check and the route recorder both read, so neither re-parses answers.
 */
class PhoneEvidenceLedger {
  private readonly turns = new Map<string, PhoneEvidence[]>();
  /** The newest turn's key per conversation and bot, so a caller that has lost the generation still finds its evidence. */
  private readonly latest = new Map<string, string>();
  /** Turns whose oldest entries were dropped, or whose capability ended mid-run: the run is not whole, so no route is
   * cut from it. The evidence is still handed over for the answer check. */
  private readonly notWhole = new Set<string>();
  private readonly screens = new Map<string, ScreenSnapshot>();

  /** The turn's key: its own generation, or, when the caller has lost it, the newest one this conversation and bot had.
   * A named generation is never substituted, so one turn never inherits another's evidence. */
  private resolve(turn: TurnCapability): string | null {
    const exact = evidenceKey(turn);
    if (this.turns.has(exact)) return exact;
    if (turn.generation !== "") return null;
    const newest = this.latest.get(`${turn.threadId}\u0000${turn.botId}`);
    return newest && this.turns.has(newest) ? newest : null;
  }

  evidence(turn: TurnCapability): readonly PhoneEvidence[] {
    const key = this.resolve(turn);
    return key === null ? [] : this.turns.get(key) ?? [];
  }

  /** The generation the turn's calls were actually recorded under, for a caller that has lost track of it. */
  generationOf(turn: TurnCapability): string {
    const key = this.resolve(turn);
    return key === null ? turn.generation : key.slice(key.lastIndexOf("\u0000") + 1);
  }

  /** The turn's evidence, handed over once; the ledger forgets it as it answers. */
  take(turn: TurnCapability): { evidence: readonly PhoneEvidence[]; complete: boolean } {
    const key = this.resolve(turn);
    if (key === null) return { evidence: [], complete: true };
    const held = this.turns.get(key) ?? [];
    this.turns.delete(key);
    for (const [pair, newest] of this.latest) if (newest === key) this.latest.delete(pair);
    return { evidence: held, complete: !this.notWhole.delete(key) };
  }

  /** The screen one phone last showed, or null: the screen a tap's ref was issued for. */
  lastScreen(phoneKey: string): ScreenSnapshot | null {
    return this.screens.get(phoneKey) ?? null;
  }

  /** Remember the screen an answer left, so the next call's ref is resolved against it. */
  remember(phoneKey: string, screen: ScreenSnapshot): void {
    this.screens.delete(phoneKey);
    this.screens.set(phoneKey, screen);
    evict(this.screens, MAX_LAST_SCREENS);
  }

  note(turn: TurnCapability, entry: PhoneEvidence): void {
    const key = evidenceKey(turn);
    const entries = this.turns.get(key) ?? [];
    entries.push(entry);
    // A turn past either ceiling lost its own beginning, so it is evidence of what was read but not a whole run.
    if (entries.length > MAX_EVIDENCE_PER_TURN) {
      entries.shift();
      this.notWhole.add(key);
    }
    let chars = entries.reduce((sum, item) => sum + item.text.length, 0);
    while (entries.length > 1 && chars > MAX_EVIDENCE_CHARS) {
      chars -= entries.shift()!.text.length;
      this.notWhole.add(key);
    }
    this.turns.delete(key);
    this.turns.set(key, entries);
    this.latest.delete(`${turn.threadId}\u0000${turn.botId}`);
    this.latest.set(`${turn.threadId}\u0000${turn.botId}`, key);
    evict(this.latest, MAX_EVIDENCE_TURNS);
    for (const oldest of this.turns.keys()) {
      if (this.turns.size <= MAX_EVIDENCE_TURNS) break;
      this.turns.delete(oldest);
      this.notWhole.delete(oldest);
    }
  }
}

export interface PhoneHostDeps {
  registry: PhoneRegistry;
  jobs: PhoneJobs;
  dataDir: string;
  /** The owner's learned screen maps, when the server keeps them; learning and the prompt reference are theirs. */
  screenmap?: PhoneScreenmaps;
  /** The live store bot, re-read on every check so a permission change wins over a call already under way. */
  bot(id: string): BotRecord | undefined | null;
  /** The owner whose phones a turn may use, or null when the turn is not provably the owner's. */
  turnOwner(capability: TurnCapability): string | null;
  /** True when the thread is a room, so the activity row names its author. */
  inRoom(threadId: string): boolean;
  appendMessage(threadId: string, message: Record<string, unknown>): void;
  active(capability: TurnCapability): boolean;
  /**
   * Screen writes reach every app on the phone, so each one holds for the
   * same outgoing-action card a connected-app send does. Absent fails closed:
   * this host cannot ask, so it must not control a screen.
   */
  holdOutbound?(input: PhoneOutboundHoldInput): Promise<PhoneOutboundHoldAnswer>;
  /** The turn's effective approval mode, read at call time. Absent is `ask`,
   * so every screen write waits on the person. */
  approvalMode?(botId: string, threadId: string): string;
  /**
   * The second gate over screen writes: the per-turn approvals of irreversible
   * controls. Absent is a fresh one for this host's lifetime; a test injects
   * one to grant an approval without a live person.
   */
  confirm?: PhoneConfirms;
  /**
   * Saves a file the phone sent for the chat and returns the attachment row to
   * append. Absent fails closed: this host cannot put files in the chat.
   */
  saveAttachment?(input: { name: string; mime: string; bytes: Buffer }): Promise<
    | { ok: true; attachment: { kind: "image" | "file"; path: string; mime: string; name?: string } }
    | { ok: false; text: string }
  >;
  /**
   * The person's new messages, so a phone job being waited on stops waiting. Absent
   * means off: every job waits out its timeout exactly as before.
   */
  steer?: PhoneSteer;
  /**
   * The route recorder. Absent means nothing is recorded and no route is offered,
   * which is what a test that does not care about routes gets.
   */
  routes?: PhoneRoutes;
  /**
   * The answer check's mode, read at call time so a Settings change wins over
   * the next turn. Absent is `off`: nothing is checked and no model call is made.
   */
  verifyMode?(): PhoneVerifyMode;
  /**
   * Mika's per-turn verdict on the person's own request, asked lazily once and shared by the route part and the
   * call gate: an intent — the verdict; null — asked and unreadable; undefined — not the person's turn or nothing
   * to judge with. Absent is no gate at all: every call runs as before.
   */
  intent?(turn: TurnCapability): Promise<Intent | null | undefined>;
}

export interface PhoneOutboundHoldInput {
  bot: BotRecord;
  threadId: string;
  /** The MCP-shaped name (`mcp__device__PHONE_UI_LAUNCH`) so the card names the phone. */
  tool: string;
  fullAccess: boolean;
  active: () => boolean;
}

export type PhoneOutboundHoldAnswer =
  | { ok: true; approved: boolean }
  | { ok: false; text: string };

export interface PhoneHost {
  /** The owner has a phone that allows an app this bot was granted. */
  mounts(bot: PhoneBot, owner: string | null): boolean;
  integration(bot: PhoneBot, owner: string | null, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null;
  prompt(bot: PhoneBot, owner: string | null): string;
  /** The phone part and, only beside a non-empty one, where the person is and the one fitting route: sections of
   * their own, volatile, so a turn from the phone or a repeated request does not change the cached system prompt.
   * `intent` is the gate's answer when the caller asked it, and like Mika's replay a discussion — or an answer the
   * gate could not read — keeps the route out. */
  parts(bot: PhoneBot, owner: string | null, place: PhonePlace, request?: string, intent?: Intent | null): [PromptPart, PromptPart, PromptPart];
  /** For a turn that may not use the phone although the owner's phone would serve this bot: say so, so it does not guess. */
  withheld(bot: PhoneBot, owner: string | null): string;
  /**
   * The gate that holds the approvals of irreversible screen controls. A confirmation tool,
   * if one is ever added, reaches it here to declare a request and take the person's answer.
   */
  confirm: PhoneConfirms;
  handle(body: unknown, capability: TurnCapability, assertActive: () => void): Promise<PhoneToolsList | PhoneToolResult>;
  /** The PHONE_* names for the per-bot tool grants picker (/api/connectors/tools); null when no phone is registered. */
  toolListing(): { phone: Array<{ name: string; description: string }> } | null;
  /** What this turn's phone calls read, oldest first. Empty once `endTurn` has handed it over. */
  evidenceFor(turn: TurnCapability): readonly PhoneEvidence[];
  /** The screen one phone last showed, so a tap's ref resolves to the element it came from. */
  lastScreen(phoneKey: string): ScreenSnapshot | null;
  /** The answer check's mode as it stands now: the caller reads it when a turn ends, so a Settings change wins. */
  verifyMode(): PhoneVerifyMode;
  /**
   * The turn is over: learn its route when it earned one, hand its evidence back, and forget it. `goal` is the person's
   * request as typed, `ownerKey` whose routes it may extend (null learns nothing), and `stopped` is a turn the person
   * stopped, which is never learned. Never throws.
   */
  endTurn(turn: TurnCapability, input: PhoneTurnEnd): PhoneTurnEnded;
}

/** What the server can honestly say about a turn that has just ended, for the route recorder. */
export interface PhoneTurnEnd {
  /** The person's request, as typed: a route's template is cut from it. */
  goal: string;
  /** The owner whose routes this turn may extend; absent or null learns nothing. */
  ownerKey?: string | null;
  /** The person stopped the turn, so nothing about it is worth learning. */
  stopped?: boolean;
  /** The turn's own reason not to learn: a takeover, a handoff, an automation. */
  spoiled?: boolean;
  /** A route is rebuilt from a persisted run, so there must be one; defaults to the turn's generation. */
  runId?: string | null;
  /** The route this turn's prompt carried, so the calls it made can settle that route's replay bookkeeping. */
  offeredRoute?: { ownerKey: string; id: string } | null;
}

/** A route learned from a turn: its file name and the request it answers. */
export type RouteRecorded = { id: string; template: string };

/** What a finished turn leaves behind for the caller: the evidence it read, and the route it earned, if any. */
export interface PhoneTurnEnded {
  evidence: readonly PhoneEvidence[];
  route: RouteRecorded | null;
  /** The request the evidence was read for, so the checker need not look it up again. */
  goal: string;
}

/** `off` does nothing; `log` writes one decision row and never touches the reply. A mode that edits the settled reply
 * needs a notice mechanism this server does not have for a finished turn, so `warn` is not offered.
 *
 * The mode is the Settings switch `features.phoneVerify`, read at call time through `PhoneHostDeps.verifyMode`: absent
 * is `off`, so a server that says nothing makes no model call. `log` writes one decision row per turn that had screen
 * evidence, never a message the person would see. */
export type PhoneVerifyMode = "off" | "log";

/** What the answer check needs from the caller: the turn it belongs to, the settled reply, and one model call. */
export interface PhoneVerifyOptions {
  dataDir: string;
  threadId: string;
  /** Absent is `off`: nothing is checked unless a caller says so. */
  mode?: PhoneVerifyMode;
  /** The person's request, as typed. */
  goal: string;
  /** The reply as it was written to the conversation. */
  reply: string;
  evidence: readonly PhoneEvidence[];
  /** One model call. Absent means this engine cannot make one, so nothing is checked and nothing is logged. */
  complete?: (messages: readonly VerifyMessage[]) => Promise<string>;
  timeoutMs?: number;
}

/** The messages as one prompt, for an engine whose one-off call takes text rather than a chat. */
export function verifyPrompt(messages: readonly VerifyMessage[]): string {
  return messages.map((message) => (typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"))).join("\n\n");
}

/**
 * Check a settled reply against the screens the turn read. The verdict, the criteria it did not meet and the facts no
 * screen held go to the decision log; the screens themselves never do. It never throws, never blocks and never edits
 * the reply: the caller fires it after the turn has settled.
 */
export async function verifyPhoneTurn(options: PhoneVerifyOptions): Promise<Verification | null> {
  if ((options.mode ?? "off") === "off" || !options.complete) return null;
  try {
    // Only what was actually read: a refused call read nothing, and a screen that carried no readable line is no evidence.
    const evidence: VerifyEvidence[] = [];
    options.evidence.forEach((entry, index) => {
      if (!entry.ok || entry.text.trim() === "") return;
      evidence.push({ text: entry.text, step: index + 1, kind: "screen", ...(entry.where ? { where: entry.where } : {}) });
    });
    if (evidence.length === 0) return null;
    // A turn that wrote or sent anything is judged as irreversible: its "done" is worth less than a read's.
    const irreversible = options.evidence.some((entry) => entry.ok && entry.irreversible);
    const verification = await verifyAnswer(
      { complete: options.complete, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
      { goal: options.goal, criteria: criteriaFor(options.goal, irreversible), answer: options.reply, evidence },
    );
    const unmet = verification.checks.filter((check) => check.status !== "met").map((check) => check.criterion);
    const detail = [
      `phone-verify:${verification.verdict}`,
      ...(unmet.length ? [`unmet: ${unmet.join(" | ")}`] : []),
      ...(verification.notFound.length ? [`not found: ${verification.notFound.join(" | ")}`] : []),
    ].join("; ").slice(0, 400);
    // No botId: the audit log keeps the verdict, and the bot's activity does not grow a tool that never ran.
    appendDecision(options.dataDir, {
      threadId: options.threadId,
      tool: "phone.verify",
      summary: `phone answer ${verification.verdict}`,
      decision: verification.verdict === "pass" ? "review-would-approve" : "review-would-deny",
      source: "model",
      rule: detail,
    });
    return verification;
  } catch {
    return null;
  }
}

const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";
const GONE_TEXT = "This bot no longer exists.";
/** The tool answer a discussion verdict leaves: the person was talking, so the call never ran and the model answers in text. */
const PHONE_DISCUSS_TEXT = "The person is discussing or reviewing, not asking anything to be done. Answer their message directly in text — do not read or operate apps, websites or other outside content this turn.";

/** The default phone: used ones first, the latest use first; then never-used ones, the newest pairing first. The poll
 * heartbeat (`seen`) never ranks: a phone that merely polled must not take a send meant for the one in use. */
const byUse = (a: PhoneRecord, b: PhoneRecord) =>
  a.lastUsedAt !== null && b.lastUsedAt !== null ? b.lastUsedAt - a.lastUsedAt
    : a.lastUsedAt !== null ? -1 : b.lastUsedAt !== null ? 1 : b.registeredAt - a.registeredAt;
const allows = (phone: PhoneRecord, cap: PhoneCapability) => Boolean(phone.registration.capabilities[cap]);
const target = (phone: PhoneRecord): PhoneTarget => ({ key: phone.key, name: phone.registration.name, platform: phone.registration.platform });
const notAllowed = (phone: string, name: PhoneToolName): PhoneRefusal =>
  ({ ok: false, code: "denied", text: `${phone} does not allow ${capName(phoneToolCapability(name))}.` });
const denied = (name: string, text: string, rule: string, code: ChatNoticeKey): PhoneAccess =>
  ({ ok: false, text, rows: [{ tool: name, ...noticeSummary(code), decision: "auto-denied", rule }] });

/** A nudge rides in the answer the model reads, under the same `note` key the phone's own answers carry, so the phone
 * never has to know the field. A note the phone wrote itself is kept in front of it. A failed call keeps its own
 * sentence: its nudge would claim the screen did not move, which is not what a failure says. */
function withNudge(outcome: PhoneJobOutcome, nudge: string): PhoneJobOutcome {
  if (!outcome.ok) return outcome;
  const result = outcome.result;
  const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
  const said = typeof record?.note === "string" && record.note.trim() ? `${record.note} ` : "";
  return { ok: true, result: record ? { ...record, note: `${said}${nudge}` } : { result, note: nudge } };
}

export function createPhoneHost(deps: PhoneHostDeps): PhoneHost {
  const { registry, jobs } = deps;
  /** The per-turn approvals of irreversible screen controls, and the last screen each phone showed. */
  const confirms = deps.confirm ?? new PhoneConfirms();
  /** What each turn's calls read, and the last screen each phone showed: the evidence both later pieces read. */
  const ledger = new PhoneEvidenceLedger();
  /** The route recorder, when the server wired one; recording is on there and reuse is not offered unless it is. */
  const routes = deps.routes;
  /** The owner's phones that allow at least one app, in default order. */
  const phonesOf = (owner: string) => registry.forOwner(owner)
    .filter((phone) => Object.values(phone.registration.capabilities).some(Boolean))
    .sort(byUse);
  /** The apps any of the owner's phones allows: what exists for the verdict. The chosen phone's own apps decide the pick. */
  const merged = (phones: PhoneRecord[]) => Object.assign({}, ...phones.map((phone) => phone.registration.capabilities)) as Partial<Record<PhoneCapability, string>>;
  const mounts = (bot: PhoneBot, owner: string | null) => {
    if (owner === null) return false;
    const grants = phoneAppsFor(bot);
    const granted = (Object.keys(grants) as PhoneCapability[]).filter((cap) => grants[cap]);
    return phonesOf(owner).some((phone) => granted.some((cap) => allows(phone, cap)));
  };
  const prompt = (bot: PhoneBot, owner: string | null) => (owner === null ? "" : phoneSystemPrompt(bot, phonesOf(owner).map(({ registration }) => registration)));
  /**
   * One answered call, as the ledger keeps it: the screen it read, the screen it was made against, and whether it moved
   * anything. A refused call is kept with `ok: false` and no text, so the answer check knows nothing was read and the
   * route recorder never mistakes it for a step. Nothing here throws: a call is never affected by its own bookkeeping.
   */
  const noteEvidence = (
    turn: TurnCapability, phoneKey: string, name: string, args: Record<string, unknown>,
    before: ScreenSnapshot | null, outcome: PhoneJobOutcome,
  ): void => {
    try {
      const result = outcome.ok ? recordOf(outcome.result) ?? {} : {};
      const screen = outcome.ok ? screenFromAnswer(outcome.result) : null;
      // A write's answer is the screen after it, so a screen that differs from the one before is the change a route
      // replays; a run's answer is the screen it ended on, which is the same comparison.
      const moved = outcome.ok && isPhoneWrite(name) && screen !== null && !sameScreen(before, screen);
      ledger.note(turn, {
        tool: name,
        text: screen ? readableLines(screen).join("\n") : "",
        where: screen?.packageName ?? null,
        before,
        screen,
        args,
        // A screen the phone left different from the one it was shown is the evidence a route replays; the phone's own
        // answer need not spell `changed` out for a tap that plainly moved.
        result: moved ? { ...result, changed: true } : result,
        ok: outcome.ok,
        changed: outcome.ok && (moved || effectiveWrite(name, result)),
        irreversible: isPhoneWrite(name),
        incomplete: outcome.ok && runCutShort(name, result),
        protected: outcome.ok && shielded(result),
        at: Date.now(),
      });
      if (screen) {
        ledger.remember(phoneKey, screen);
        // The map learns from the screen the answer carried: the step from the
        // screen the call was read against to this one is one navigation edge.
        const owner = deps.turnOwner(turn);
        if (owner !== null) deps.screenmap?.observe(owner, phoneKey, name, targetOf(name, args, before)?.text ?? null, before, screen);
      }
    } catch {
      // A ledger that cannot keep one call must not affect the call.
    }
  };
  return {
    mounts,
    integration(bot, owner, mint, harnessUrl) {
      if (!mounts(bot, owner)) return null;
      const token = mint();
      return {
        command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, PHONE_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("device")]: token, LUNABOT_HARNESS_URL: harnessUrl },
      };
    },
    prompt,
    parts(bot, owner, place, request?: string, intent?: Intent | null) {
      const text = prompt(bot, owner);
      // One fitting route is told to the bot so it can replay it; a shortlist it would have to choose between is
      // not offered, because a classifier has to pick and nothing here may call a model. A gate that answered keeps
      // the path out too: a discussion, or an answer it could not read, means nothing was asked to be done.
      const matched = request && owner !== null && routes ? routes.match(owner, request) : [];
      const route = intent === "discuss" || intent === null ? null : needsDecision(matched) ? null : (matched[0] ?? null);
      // The learned screen map rides with the route: a reference the bot reads
      // before it drives, never a promise the screens are still like this.
      const map = owner !== null && deps.screenmap ? deps.screenmap.reference(owner) : "";
      return [
        { id: "device", label: "Phone", text },
        { id: "device-place", label: "Where the person is", text: text && PHONE_PLACE_PROMPT[place] },
        { id: "device-route", label: "A path that worked before", text: text && `${route ? routePrompt(route, request!) : ""}${route && map ? "\n\n" : ""}${map}` },
      ];
    },
    withheld: (bot, owner) => (owner !== null && mounts(bot, owner) ? phoneWithheldPrompt(bot, phonesOf(owner).map(({ registration }) => registration)) : ""),
    confirm: confirms,
    toolListing: () => (registry.list(null, () => false).length === 0 ? null : { phone: PHONE_TOOLS.map(({ name, description }) => ({ name, description })) }),
    evidenceFor: (turn) => ledger.evidence(turn),
    lastScreen: (phoneKey) => ledger.lastScreen(phoneKey),
    /** Read on each call rather than captured, so a Settings change reaches the next turn. */
    verifyMode: () => deps.verifyMode?.() ?? "off",
    /**
     * The turn is over. Its calls are offered to the route recorder one at a time, and a route is kept only when the
     * turn ended without a stop and at least one successful screen-changing write moved the screen: anything else is
     * not learnable, so nothing is written. The evidence is handed over either way, and never kept afterwards.
     */
    endTurn(turn, input) {
      // The generation the calls were recorded under: a caller that has already cleared the turn's own still finds them.
      const generation = ledger.generationOf(turn);
      const { evidence, complete } = ledger.take(turn);
      const ended: PhoneTurnEnded = { evidence, route: null, goal: input.goal };
      // The route the prompt carried is settled only against calls that ran — a refusal, a timeout or a phone not
      // there never ran, so it says nothing about the path — and only when the turn's end can judge: a stopped or
      // spoiled turn just touches the route, the way Mika counts a replay stopped for confirmation as use alone.
      if (routes && input.offeredRoute) {
        const ran = evidence.filter((entry) => entry.ok && isReplayablePhoneTool(entry.tool));
        if (ran.length > 0) {
          const missed = ran.findIndex((entry) => !entry.changed);
          routes.settle(input.offeredRoute.ownerKey, input.offeredRoute.id,
            input.stopped === true || input.spoiled === true ? "used" : missed === -1 ? "success" : "miss",
            missed === -1 ? undefined : missed);
        }
      }
      const ownerKey = input.ownerKey ?? null;
      if (!routes || ownerKey === null || evidence.length === 0 || !complete) return ended;
      try {
        const routeTurn: RouteTurn = {
          ownerKey, threadId: turn.threadId, botId: turn.botId, generation,
          goal: input.goal, runId: input.runId ?? generation,
        };
        for (const entry of evidence) {
          // A refused or skipped call never ran, so it is evidence of what the turn saw, never a step of what it did.
          if (!entry.ok) continue;
          routes.note(routeTurn, {
            tool: entry.tool,
            args: entry.args,
            target: targetOf(entry.tool, entry.args, entry.before),
            screen: entry.before,
            after: entry.screen,
            result: entry.result,
            incomplete: entry.incomplete,
            protected: entry.protected,
          });
        }
        const moved = evidence.some((entry) => entry.ok && entry.changed && isReplayablePhoneTool(entry.tool));
        const stopped = input.stopped === true;
        const route = routes.finish(routeTurn, {
          outcome: !stopped && !input.spoiled && moved ? "done" : "partial",
          spoiled: stopped || input.spoiled === true,
        });
        return { ...ended, route: route ? { id: route.id, template: route.template } : null };
      } catch {
        return ended;
      }
    },
    async handle(body, capability, assertActive) {
      const turn = { threadId: capability.threadId, botId: capability.botId, generation: capability.generation };
      // A turn that the server says is no longer live has no run left to guard: its loop state goes with it, so the next
      // turn in the same conversation starts clean even though the phone's last screen stands.
      const assertLive = () => {
        try {
          assertActive();
        } catch (error) {
          confirms.resetGuard(turn);
          throw error;
        }
      };
      return phoneRpc(body as { method?: unknown; params?: unknown }, {
        assertActive: assertLive,
        // Re-read the live bot and the turn's owner on every call, so a permission change wins over a request
        // authenticated under the old one.
        authorize: (name) => {
          const bot = deps.bot(capability.botId);
          if (!bot) return { ok: false, text: GONE_TEXT };
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : phonesOf(owner);
          const verdict = owner === null ? denied(name, NOT_OWNER_TEXT, "phone:not-owner", "chat.notice.phone.notOwner")
            : phones.length === 0 ? denied(name, PHONE_NO_PHONE_TEXT, "phone:no-phone", "chat.notice.phone.noPhone")
              : phoneAccess(bot, merged(phones), name);
          for (const row of verdict.rows) {
            appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: row.tool, decision: row.decision, source: "connector-scope", rule: row.rule, ...(row.summary ? { summary: row.summary, summaryCode: row.summaryCode, summaryParams: row.summaryParams } : {}) });
          }
          return verdict.ok ? { ok: true } : { ok: false, text: verdict.text };
        },
        // A named phone is looked up among all of the owner's phones; the default only among those allowing the tool's app.
        phone: (preferred, name) => {
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : registry.forOwner(owner).sort(byUse);
          if (preferred === undefined) {
            const chosen = phones.find((phone) => allows(phone, phoneToolCapability(name)));
            return chosen ? target(chosen) : null;
          }
          if (phones.length === 0) return null;
          const wanted = preferred.trim().toLowerCase();
          const match = phones.find((phone) => phone.registration.name.trim().toLowerCase() === wanted);
          if (!match) return { ok: false, code: "no_phone", text: `${PHONE_NO_PHONE_TEXT} Available phones: ${phones.map((phone) => phone.registration.name).join(", ")}.` };
          return allows(match, phoneToolCapability(name)) ? target(match) : notAllowed(match.registration.name, name);
        },
        run: async (phone, name, args): Promise<PhoneJobOutcome> => {
          const owner = deps.turnOwner(capability);
          // The screen the call is about to be made against: a tap's ref names an element on it, so it is resolved here
          // before the phone answers and moves the screen on.
          const before = ledger.lastScreen(phone.key);
          /** A call this host refused or skipped: nothing ran, and nothing was read, but it is still what the turn saw. */
          const refuse = (outcome: PhoneJobOutcome): PhoneJobOutcome => {
            noteEvidence(turn, phone.key, name, args, before, outcome);
            return outcome;
          };
          // Mika's gate stands at the turn's first outside call: a discussion verdict refuses this call and, through
          // the cached verdict, every later one — the person was talking, so the model answers in text instead.
          if ((await deps.intent?.(turn)) === "discuss") return refuse({ ok: false, code: "denied", error: PHONE_DISCUSS_TEXT });
          // A bot looping on a phone is caught before the card asks the person anything: the same action on a screen that
          // did not move earns a nudge in the answer, and then a refusal, so a stuck task ends instead of running on.
          const advice = isPhoneUiWrite(name) ? confirms.advise(turn, phone.key, name, args) : { result: "proceed" as const };
          if (advice.result === "stop") return refuse({ ok: false, code: "denied", error: advice.reason });
          const active = () => {
            if (!deps.active(capability) || owner === null || deps.turnOwner(capability) !== owner) return false;
            const bot = deps.bot(capability.botId);
            const current = registry.get(phone.key);
            return Boolean(bot && current && current.owner === owner && phoneAccess(bot, current.registration.capabilities, name).ok);
          };
          // A screen write reaches every app on the phone: it holds for the
          // outgoing-action card before any job reaches the device. The hold
          // itself skips the card at Full access, exactly as a send does.
          if (isPhoneUiWrite(name)) {
            const bot = deps.bot(capability.botId);
            if (!bot) return refuse({ ok: false, code: "denied", error: GONE_TEXT });
            const hold = deps.holdOutbound;
            if (!hold) return refuse({ ok: false, code: "denied", error: "This server cannot ask for approval, so it cannot control a phone screen." });
            const held = await hold({
              bot,
              threadId: capability.threadId,
              tool: `mcp__${PHONE_MCP_SERVER}__${name}`,
              fullAccess: (deps.approvalMode?.(bot.id, capability.threadId) ?? "ask") === "full",
              active,
            });
            if (!held.ok) return refuse({ ok: false, code: "denied", error: held.text });
            // The person may have taken the turn back while the card waited.
            if (!active()) return refuse({ ok: false, code: "denied", error: GONE_TEXT });
          }
          // The card approved the tool call; the gate then binds that approval to the exact control. A refusal here
          // is an authorization decision the card rows never show, so it is logged with the step's risk grade.
          const noteGateRefusal = (refused: { reason: string; risk: RiskGrade }) => {
            const bot = deps.bot(capability.botId);
            if (!bot) return;
            appendDecision(deps.dataDir, {
              threadId: capability.threadId, botId: bot.id, botName: bot.name,
              tool: `mcp__${PHONE_MCP_SERVER}__${name}`,
              summary: refused.reason, decision: "auto-denied", source: "outbound",
              rule: `phone-risk:${refused.risk.level}`,
            });
          };
          // A second, narrower gate: the card above approves the tool call, so it is also the person's approval of the
          // control, once and for one action. A run that hides a control in its steps is refused instead.
          const approval = isPhoneUiWrite(name) ? confirms.approveCard(turn, phone.key, name, args) : { result: "approved" as const };
          if (approval.result === "refused") {
            noteGateRefusal(approval);
            return refuse({ ok: false, code: "denied", error: approval.reason });
          }
          const check = isPhoneUiWrite(name) ? confirms.check(turn, phone.key, name, args) : { result: "proceed" as const };
          if (check.result === "refused") {
            noteGateRefusal(check);
            return refuse({ ok: false, code: "denied", error: check.reason });
          }
          const job = jobs.request(phone.key, name, args, {
            // A UI control keeps the short job timeout: it already waited on
            // the person's approval above, not on a Send tap on the phone.
            active, timeoutMs: phoneToolSends(name) ? PHONE_SEND_TIMEOUT_MS : PHONE_JOB_TIMEOUT_MS,
            offlineText: `${phone.name} is offline. Open the Luna Bot app on it.`, online: () => registry.online(phone.key),
          });
          // The person's new message ends the wait, not the job: it may already have run on the phone, so it is left to
          // finish and only its answer goes unread. Nothing here was performed differently, so the loop guard and the
          // gate stay as they are and the turn goes on to read what they said.
          const raced = deps.steer ? await deps.steer.race(turn, turn.generation, job) : { kind: "done" as const, value: await job };
          if (raced.kind === "steered") return refuse({ ok: false, error: SKIPPED_FOR_NEW_MESSAGE });
          const outcome = raced.value;
          if (outcome.ok) registry.used(phone.key);
          // The do_each detector sees every executed call, reads and sends
          // included: a verb outside its motif breaks the run, as upstream's
          // feed does. It fires at most once per turn.
          const eachNudge = confirms.noteEach(turn, name, args, outcome.ok);
          // The answer's screen is recorded first, so the loop guard reads the screen the answer left, then the call
          // joins that guard's history. A read that took a snapshot moves the guard's trail along the same way.
          if (outcome.ok && recordsScreen(name) && confirms.noteScreen(phone.key, outcome.result)) {
            confirms.noteGuard(turn, phone.key, name, args);
          }
          // A control the gate let through used up its approval; any other screen write voids one still waiting, since
          // the step the person approved is no longer the step the bot is on. Typing is part of an approved send.
          if (outcome.ok && isPhoneUiWrite(name)) confirms.noteWrite(turn, name === "PHONE_UI_TYPE" ? "typing" : "other", typeof args.text === "string" ? args.text : undefined);
          // A turn that ended while the job waited, or a phone dropped while it did, has no run left to guard: the next
          // turn starts clean. A turn that outlives this call keeps its guard, and a new generation starts fresh anyway.
          if ((!outcome.ok && outcome.code === "turn_ended") || !registry.get(phone.key)) confirms.resetGuard(turn);
          noteEvidence(turn, phone.key, name, args, before, outcome);
          const nudge = [advice.result === "warn" ? advice.nudge : null, eachNudge]
            .filter((text): text is string => text !== null)
            .join(" ");
          return nudge.length > 0 ? withNudge(outcome, nudge) : outcome;
        },
        onWrite: (record) => {
          const bot = deps.bot(capability.botId);
          deps.appendMessage(capability.threadId, {
            role: "bot", kind: "activity",
            tool: { name: `mcp__${PHONE_MCP_SERVER}__${record.tool}`, ok: true, summary: record.summary, summaryCode: record.summaryCode, summaryParams: record.summaryParams },
            ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
          });
        },
        attachFile: deps.saveAttachment ? async (input) => {
          const saved = await deps.saveAttachment!(input);
          if (!saved.ok) return saved;
          const bot = deps.bot(capability.botId);
          deps.appendMessage(capability.threadId, {
            role: "bot", kind: "text", text: "",
            attachments: [saved.attachment],
            ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
          });
          return { ok: true as const, text: `已把「${saved.attachment.name ?? input.name}」放进这个对话。` };
        } : undefined,
      });
    },
  };
}

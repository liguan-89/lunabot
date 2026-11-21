// A second, narrower layer over a phone screen write. The outgoing-action card approves one tool call, which cannot tell
// "tap Back" from "tap 付款"; this one reads the control's own words with shared/irreversible.ts, so the card's approval
// covers one exact irreversible step and the gate then uses it up. The state lives here, per turn and per phone, so
// host.ts stays the wiring. It also holds the loop guard's state and the screen fingerprint that guard compares, so
// neither has a store of its own.
import { createHash } from "node:crypto";

import {
  ConfirmGate,
  classifyControl,
  type ConfirmationRequest,
  type ControlElement,
  type ControlInput,
  type DeclareResult,
  type IrreversibleHit,
  type Permit,
  type ScreenElement,
  type ScreenView,
  type WriteKind,
} from "../../shared/irreversible.ts";
import { isPhoneUiWrite } from "../../shared/outbound.ts";
import {
  actionSignature,
  checkAction,
  noteAction as noteGuardAction,
  noteScreen as guardNoteScreen,
  reset as freshGuard,
  type GuardState,
  type GuardVerdict,
} from "../phone-guards.ts";

/** The pair one gate belongs to: an approval never crosses threads or bots. `generation` names the turn, so a new turn
 * in the same conversation starts with no grants, no refusals and no spent cards of the one before. */
export interface ConfirmTurn { threadId: string; botId: string; generation?: string }

/** The pair, and the turn it is: a loop guard starts over when the turn does, though the phone's screen stands. */
export interface GuardTurn extends ConfirmTurn { generation: string }

/** The fields of one phone element this module keeps: the gate's, plus the ref a tap names it by. */
type PhoneScreenElement = ControlElement & { ref?: string | null };

/** One screen as the phone sent it, narrowed: no image bytes and no field this module does not read. */
interface PhoneScreen {
  /** The Android package in front, as `topPackage` on the wire. */
  topPackage: string | null;
  elements: PhoneScreenElement[];
  /** The display height in the same pixels as bounds, when the answer said it. */
  height?: number;
  /** What the screen reads as, for the loop guard. */
  fingerprint: string;
}

/** A screen as it was recorded, with whether it differs from the screen this phone showed before it. */
type PhoneScreenRecord = PhoneScreen & { changed: boolean };

/** How many turns keep a gate and a loop guard, and how many phones keep a screen; the oldest is dropped past this, so
 * a long-lived server does not grow without bound. */
export const MAX_CONFIRM_TURNS = 200;
export const MAX_CONFIRM_SCREENS = 200;

/** A target longer than this is clipped: the gate compares only its first characters, and the sentence stays short. */
const TARGET_MAX = 80;

const MCP_PREFIX = /^mcp__(?:composio|own_apps|device)__/;

/** The gate is per (thread, bot): two bots in one room never share an approval. */
export function confirmKey(turn: ConfirmTurn): string {
  return `${turn.threadId}\u0000${turn.botId}`;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

function boundsOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  return value.every((part) => typeof part === "number" && Number.isFinite(part)) ? value as number[] : null;
}

/** One element, or null when the phone sent something that is not one: its JSON is not trusted. */
function elementOf(value: unknown): PhoneScreenElement | null {
  const element = recordOf(value);
  if (!element) return null;
  return {
    ref: typeof element.ref === "string" && element.ref ? element.ref : null,
    text: textOf(element.text),
    description: textOf(element.description),
    viewId: textOf(element.viewId),
    // The phone writes the class name as `class`; a narrowed screen may already carry it as className.
    className: textOf(element.className) ?? textOf(element.class),
    bounds: boundsOf(element.bounds),
    clickable: element.clickable === true,
    editable: element.editable === true,
    scrollable: element.scrollable === true,
    password: element.password === true,
  };
}

/**
 * The screenshot's height is that of the scaled JPEG, not of the display its bounds use; `scale` converts it back.
 * Without one the raw height only makes the gate's title band stricter, never looser.
 */
function heightOf(screen: Record<string, unknown>): number | undefined {
  const height = screen.height;
  if (typeof height !== "number" || !(height > 0)) return undefined;
  const scale = screen.scale;
  return typeof scale === "number" && scale > 0 ? Math.round(height / scale) : height;
}

/** The screen an answer carries: the answer itself, or the `screen` a PHONE_UI_RUN result holds. Null when it holds no
 * element list, which is how a launch or an OCR answer differs from a screen. */
function screenOf(result: unknown): PhoneScreen | null {
  const record = recordOf(result);
  if (!record) return null;
  const screen = recordOf(record.screen) ?? record;
  if (!Array.isArray(screen.elements)) return null;
  const elements = screen.elements.map(elementOf).filter((element): element is PhoneScreenElement => element !== null);
  const height = heightOf(screen);
  const topPackage = typeof screen.topPackage === "string" && screen.topPackage ? screen.topPackage : null;
  return { topPackage, elements, ...(height !== undefined ? { height } : {}), fingerprint: fingerprintOf(topPackage, elements) };
}

/**
 * What a screen reads as, for the loop guard: the app in front and each element's label, id, class and box, hashed so a
 * long screen is one short string. Refs are left out because the phone issues new ones for every snapshot, so a screen
 * that did not move must read the same; a tap that changed nothing therefore matches the screen it was read against.
 */
function fingerprintOf(topPackage: string | null, elements: readonly PhoneScreenElement[]): string {
  const readable = elements.map((element) => [
    element.text, element.description, element.viewId, element.className, element.bounds, element.clickable, element.editable,
  ]);
  return createHash("sha1").update(JSON.stringify([topPackage, readable])).digest("hex").slice(0, 16);
}

function viewOf(screen: PhoneScreen | null): ScreenView {
  if (!screen) return { packageName: null, elements: [] };
  const elements: ScreenElement[] = screen.elements.map(({ text, description, editable, scrollable, bounds }) => ({
    text, description, editable, scrollable, bounds,
  }));
  return { packageName: screen.topPackage, elements, ...(screen.height !== undefined ? { height: screen.height } : {}) };
}

/**
 * What the gate reads of a phone answer: the package in front, its elements and the display height. Malformed input
 * reads as an empty screen rather than a throw: the answer comes from the phone, not from this server.
 */
export function screenViewOf(result: unknown): ScreenView {
  return viewOf(screenOf(result));
}

function screenTextsOf(screen: PhoneScreen | null): string[] {
  const texts: string[] = [];
  for (const element of screen?.elements ?? []) {
    for (const text of [element.text, element.description]) if (typeof text === "string" && text.trim()) texts.push(text);
  }
  return texts;
}

/** The smallest element whose bounds hold the point: the one a tap there would reach. */
function elementAt(screen: PhoneScreen | null, x: number, y: number): PhoneScreenElement | null {
  let found: PhoneScreenElement | null = null;
  let area = Number.POSITIVE_INFINITY;
  for (const element of screen?.elements ?? []) {
    const bounds = element.bounds;
    if (!bounds) continue;
    if (x < bounds[0]! || y < bounds[1]! || x > bounds[2]! || y > bounds[3]!) continue;
    const size = (bounds[2]! - bounds[0]!) * (bounds[3]! - bounds[1]!);
    if (size < area) { found = element; area = size; }
  }
  return found;
}

/** The element a step names: by ref when it has one, else the first whose text or view id contains the given one. */
function elementNamed(screen: PhoneScreen | null, named: Record<string, unknown>): PhoneScreenElement | null {
  const ref = typeof named.ref === "string" && named.ref ? named.ref : null;
  if (ref) return screen?.elements.find((element) => element.ref === ref) ?? null;
  const text = typeof named.text === "string" && named.text.trim() ? named.text.trim().toLowerCase() : null;
  const resourceId = typeof named.resourceId === "string" && named.resourceId ? named.resourceId.toLowerCase() : null;
  return screen?.elements.find((element) =>
    (text !== null && [element.text, element.description].some((label) => label?.toLowerCase().includes(text)))
    || (resourceId !== null && element.viewId?.toLowerCase().includes(resourceId))) ?? null;
}

/**
 * The first step of a PHONE_UI_RUN the word list names, read against the screen as it stands now, so a run is not a way
 * around this gate. A step whose target is not on this screen cannot be judged and is passed over: the run finds it on a
 * later screen this server has not seen.
 */
function runControl(args: Record<string, unknown>, screen: PhoneScreen | null): ControlInput | null {
  const commands = Array.isArray(args.commands) ? args.commands : [];
  const screenTexts = screenTextsOf(screen);
  for (const value of commands) {
    const command = recordOf(value);
    if (!command) continue;
    const op = command.op;
    const input: ControlInput | null = op === "tap" ? { element: elementNamed(screen, command), screenTexts }
      : op === "key" && command.key === "enter" ? { interaction: "enter", screenTexts }
        // Typing then enter is the same send as pressing enter on the focused field.
        : op === "type" && command.pressEnter === true ? { interaction: "enter", screenTexts }
          : op === "swipe" && (command.direction === "left" || command.direction === "right") ? { interaction: "swipe", screenTexts }
            : null;
    if (input && classifyControl(input)) return input;
  }
  return null;
}

function controlOn(tool: string, args: Record<string, unknown>, screen: PhoneScreen | null): ControlInput | null {
  const name = tool.replace(MCP_PREFIX, "");
  const screenTexts = screenTextsOf(screen);
  if (name === "PHONE_UI_TAP") {
    const ref = typeof args.ref === "string" ? args.ref : null;
    return { element: ref ? screen?.elements.find((element) => element.ref === ref) ?? null : null, screenTexts };
  }
  // The classifier cannot hit-test a point, so resolve the element under it first, as its own doc says to; otherwise
  // tapping a coordinate would be the way around this gate.
  if (name === "PHONE_UI_TAP_AT") {
    const x = typeof args.x === "number" ? args.x : null;
    const y = typeof args.y === "number" ? args.y : null;
    return { element: x === null || y === null ? null : elementAt(screen, x, y), screenTexts };
  }
  // The phone names no focused field, so an enter key is the send the classifier assumes; other keys act on nothing.
  if (name === "PHONE_UI_KEY") return args.key === "enter" ? { interaction: "enter", screenTexts } : null;
  // A swipe names no element; a horizontal one is the gesture a list row reads as a delete.
  if (name === "PHONE_UI_SWIPE") {
    return args.direction === "left" || args.direction === "right" ? { interaction: "swipe", screenTexts } : null;
  }
  if (name === "PHONE_UI_RUN") return runControl(args, screen);
  return null;
}

/**
 * Which element a call is about, as the classifier reads it. Null for a tool that is not a control: observing, querying,
 * launching, scrolling, typing, going back, waiting, a screenshot or OCR. Accepts the MCP-shaped name too.
 *
 * A coordinate tap is resolved to the smallest element under the point, and a run to the first of its steps the word
 * list names on this screen, so neither is the way around the gate.
 */
export function controlFor(tool: string, args: Record<string, unknown>, observeResult: unknown): ControlInput | null {
  return controlOn(tool, args, screenOf(observeResult));
}

/** Every tool whose answer is a full snapshot: the reads that take one, and the driving actions that answer with the
 * screen they ended on. A query's answer carries only the elements it matched, so it is not one. A find's answer is a
 * match list too, but it carries the whole screen beside it in `screen`, because the refs it hands out belong to that
 * snapshot and a later step names them. */
const SCREEN_ANSWERS: ReadonlySet<string> = new Set([
  "PHONE_UI_OBSERVE", "PHONE_UI_SCREENSHOT", "PHONE_UI_RUN", "PHONE_UI_WAIT", "PHONE_UI_COLLECT",
  "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL",
  "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK", "PHONE_UI_FIND",
]);

/** Does this tool's answer carry the whole screen as it now is? Recording anything else would shrink the screen the next
 * control is read against. */
export function recordsScreen(tool: string): boolean {
  return SCREEN_ANSWERS.has(tool.replace(MCP_PREFIX, ""));
}

/** The sentence the bot reads: which control, which kind, and that the person must be asked first. */
function controlWhat(input: ControlInput, hit: IrreversibleHit): string {
  return input.interaction === "enter" ? "pressing the enter key"
    : input.interaction === "swipe" ? "this swipe"
      : `tapping ${hit.matched}`;
}

/** A payment is never approved here at all (ConfirmGate.declare refuses the kind), so that sentence asks the person to
 * do it themselves rather than to approve it. */
function payRefusal(input: ControlInput, hit: IrreversibleHit): string {
  return `Not run: ${controlWhat(input, hit)} is the irreversible action "pay", and a payment is never approved for a bot here. ` +
    "Ask the person to make the payment themselves.";
}

/** The card named the tool, not the control, so a screen that changed under it approves nothing. */
function changedRefusal(input: ControlInput, hit: IrreversibleHit): string {
  return `Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", but the screen changed or the app in front is not the one the card was approved on. ` +
    "Ask the person again.";
}

/** One approval covers one irreversible step; the next of the same kind needs the person's own answer, not a card. */
function spentRefusal(input: ControlInput, hit: IrreversibleHit): string {
  return `Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and one approval of this kind was already used in this task. ` +
    "Ask the person again; a new turn gets a fresh card for the step.";
}

function declinedRefusal(input: ControlInput, hit: IrreversibleHit): string {
  return `Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and the person refused it earlier in this task. ` +
    "Ask the person what they would like instead.";
}

/** A run is one card for a whole chain, so an irreversible step inside it must not ride that card. */
function runRefusal(input: ControlInput, hit: IrreversibleHit): string {
  const step = `this PHONE_UI_RUN includes ${controlWhat(input, hit)}, the irreversible action "${hit.action}"`;
  if (hit.action === "pay") {
    return `Not run: ${step}, and a payment is never approved for a bot here. ` +
      "Run the other steps with PHONE_UI_RUN, and ask the person to make the payment themselves.";
  }
  return `Not run: ${step}. Run the other steps with PHONE_UI_RUN, then that one step alone, so the person sees a card for exactly that.`;
}

/** Why an approved card still grants nothing, and what the bot does instead. */
type CardOutcome = Exclude<DeclareResult, "pending"> | "spent" | "run";

/** The sentence for a card the gate could not turn into a grant. */
function cardRefusal(input: ControlInput, hit: IrreversibleHit, outcome: CardOutcome): string {
  if (outcome === "unsupported") return payRefusal(input, hit);
  if (outcome === "mismatch") return changedRefusal(input, hit);
  if (outcome === "declined") return declinedRefusal(input, hit);
  if (outcome === "spent") return spentRefusal(input, hit);
  return runRefusal(input, hit);
}

/** What an approved card became: a grant for this one step, or the sentence saying why it grants nothing. */
export type CardApproval = { result: "approved" } | { result: "refused"; reason: string };

/** The text a PHONE_UI_TYPE call would type; every other control carries none. */
function contentOf(tool: string, args: Record<string, unknown>): string {
  return tool.replace(MCP_PREFIX, "") === "PHONE_UI_TYPE" && typeof args.text === "string" ? args.text : "";
}

/** One card per kind of action per app per turn: the first covers the step it named, and a second needs the person. */
function cardKey(action: ConfirmationRequest["action"], app: string): string {
  return `${action}\u0000${app}`;
}

function refusal(input: ControlInput, hit: IrreversibleHit, permit: Permit): string {
  if (hit.action === "pay") return payRefusal(input, hit);
  const why = permit.result === "mismatch" ? ` (${permit.reason})` : "";
  return `Not run: ${controlWhat(input, hit)} is the irreversible action "${hit.action}", and the person has not approved this exact step${why}. ` +
    "Ask the person to say this exact step may run; a new turn gets a fresh card for the retry.";
}

/** What one pending screen control needs: run it, or stop and ask. `allowed` means the gate used up the approval. */
export type ConfirmCheck =
  | { result: "proceed" }
  | { result: "allowed"; hit: IrreversibleHit }
  | { result: "refused"; hit: IrreversibleHit; reason: string };

/** What the loop guard makes of a screen-driving call before it is queued: run it, run it with a nudge, or refuse it. */
export type GuardAdvice =
  | { result: "proceed" }
  | { result: "warn"; nudge: string }
  | { result: "stop"; reason: string };

/** The sentence a refused call answers with: the guard's code, that repeating it cannot help, and that the run ends. */
function stuckReason(verdict: GuardVerdict): string {
  return `Not run: this task is stuck on the phone (${verdict.code}), and the same action again will not move it. ` +
    "Stop here and report what is done and what is still blocked.";
}

function evict<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

/** The per-turn gates, the loop guard, and the last screen each phone showed. One lives for the server's lifetime;
 * every map evicts its oldest entry, so a long-lived server does not grow without bound. */
export class PhoneConfirms {
  private readonly turns = new Map<string, { generation: string; gate: ConfirmGate; step: number; cards: Set<string> }>();
  private readonly screens = new Map<string, PhoneScreenRecord>();
  private readonly guards = new Map<string, { generation: string; state: GuardState }>();

  /** How many turns hold a gate; a test reads it to see the bound hold. */
  get size(): number {
    return this.turns.size;
  }

  /** How many turns hold a loop guard; a test reads it to see the bound hold. */
  get guardSize(): number {
    return this.guards.size;
  }

  /** Record the screen an answer carries; an answer with no element list leaves the last screen alone. True when one was
   * recorded, so the caller knows the loop guard has this answer to read. The first screen a phone shows counts as a
   * change: there is nothing to compare it with, and a phone this server has just met is not stuck. */
  noteScreen(phoneKey: string, result: unknown): boolean {
    const screen = screenOf(result);
    if (!screen) return false;
    const previous = this.screens.get(phoneKey);
    this.screens.delete(phoneKey);
    this.screens.set(phoneKey, { ...screen, changed: previous === undefined || previous.fingerprint !== screen.fingerprint });
    evict(this.screens, MAX_CONFIRM_SCREENS);
    return true;
  }

  /** The app in front on the last screen this phone showed, or "" when it showed none: an approval needs one. */
  foreground(phoneKey: string): string {
    return this.screens.get(phoneKey)?.topPackage ?? "";
  }

  /**
   * The outgoing card the person just approved is this call's approval: it becomes a one-shot grant for the control the
   * call is about, or the sentence saying why it grants nothing. A call the word list does not name, and a call whose
   * target is not on the last screen, need no grant and are left to `check`.
   *
   * The hold answering `ok` with `approved: false` means no card was shown because the bot's own rule or Full access
   * already lets it act unasked; that standing consent counts here too, since the person has said not to be asked. A
   * declined card never reaches this method: the hold answers `ok: false` with the person's own sentence.
   */
  approveCard(turn: ConfirmTurn, phoneKey: string, tool: string, args: Record<string, unknown>): CardApproval {
    const input = controlOn(tool, args, this.screens.get(phoneKey) ?? null);
    const hit = input ? classifyControl(input) : null;
    if (!input || !hit) return { result: "approved" };
    if (tool.replace(MCP_PREFIX, "") === "PHONE_UI_RUN") {
      return { result: "refused", reason: cardRefusal(input, hit, "run") };
    }
    const app = this.foreground(phoneKey);
    const state = this.state(turn);
    const card = cardKey(hit.action, app);
    if (state.cards.has(card)) return { result: "refused", reason: cardRefusal(input, hit, "spent") };
    const request: ConfirmationRequest = {
      action: hit.action,
      target: hit.matched.slice(0, TARGET_MAX),
      content: contentOf(tool, args),
      amount: null,
      app,
    };
    const declared = this.declare(turn, phoneKey, request);
    if (declared !== "pending") return { result: "refused", reason: cardRefusal(input, hit, declared) };
    this.decide(turn, true);
    state.cards.add(card);
    return { result: "approved" };
  }

  /**
   * The person approved one action: a one-shot grant bound to what the last screen of this phone showed. `pending`
   * means the caller should ask the person now; `unsupported` means this module never approves that kind.
   */
  declare(turn: ConfirmTurn, phoneKey: string, request: ConfirmationRequest): DeclareResult {
    return this.state(turn).gate.declare(request, this.screens.get(phoneKey)?.topPackage ?? null);
  }

  /** The person's answer to the request `declare` took; a refusal is remembered for this turn. */
  decide(turn: ConfirmTurn, approved: boolean): void {
    const state = this.state(turn);
    state.gate.decide(approved, state.step);
  }

  /**
   * What one screen write needs. `proceed` for anything the word list does not name; `allowed` when an approval covered
   * this exact step, which the gate has now used up; `refused` with the sentence to hand back to the bot.
   */
  check(turn: ConfirmTurn, phoneKey: string, tool: string, args: Record<string, unknown>): ConfirmCheck {
    const screen = this.screens.get(phoneKey) ?? null;
    const input = controlOn(tool, args, screen);
    if (!input) return { result: "proceed" };
    const hit = classifyControl(input);
    // Nothing to classify and no grant to age out: an ordinary tap starts no state of its own.
    if (!hit && !this.held(turn)) return { result: "proceed" };
    const state = this.state(turn);
    // Every control the gate looks at is a step, so a grant cannot outlive the next few taps.
    state.step += 1;
    if (!hit) return { result: "proceed" };
    const permit = state.gate.permits(hit, viewOf(screen), state.step);
    return permit.result === "allowed"
      ? { result: "allowed", hit }
      : { result: "refused", hit, reason: refusal(input, hit, permit) };
  }

  /**
   * What the loop guard makes of a screen-driving call before it is queued. A warning lets the call run and hands back
   * the nudge the answer should carry; a stop refuses it, and once a turn has stopped every later write is refused too,
   * because the task is over and a write now would only act on a screen the bot has stopped understanding.
   *
   * The call is judged as if it will do what the last one did, since its answer is not in yet: the screen it is about to
   * act on is the one recorded last, and whether the last action moved the screen stands for whether this one will. A
   * warning's state is dropped, because `noteGuard` records the same action against the answer that came back, which is
   * the same judgement the answer itself carries; a stop's is kept, since no answer will come to record it.
   */
  advise(turn: GuardTurn, phoneKey: string, tool: string, args: Record<string, unknown>): GuardAdvice {
    const state = this.guardState(turn);
    if (state.stop) return { result: "stop", reason: stuckReason(state.stop) };
    const screen = this.screens.get(phoneKey);
    const check = checkAction(state, {
      signature: actionSignature(tool, args),
      // With no answer recorded yet there is nothing to compare, so this action is not counted as one that changed
      // nothing: a phone this server has just met must not be called stuck.
      changed: screen?.changed ?? true,
      screenFingerprint: screen?.fingerprint ?? null,
    });
    if (check.verdict === null) return { result: "proceed" };
    if (check.verdict.severity === "warn") return { result: "warn", nudge: check.verdict.nudge };
    this.keepGuard(turn, check.state);
    return { result: "stop", reason: stuckReason(check.verdict) };
  }

  /**
   * Record one answer for the loop guard. A screen-driving call joins the history with whether the screen moved after
   * it; a read that took a snapshot moves the trail along, since a reread is neither progress nor a repetition. The
   * caller records the screen first, so this reads the screen the answer left.
   */
  noteGuard(turn: GuardTurn, phoneKey: string, tool: string, args: Record<string, unknown>): void {
    const screen = this.screens.get(phoneKey);
    if (!screen) return;
    const state = this.guardState(turn);
    this.keepGuard(turn, isPhoneUiWrite(tool)
      ? noteGuardAction(state, { signature: actionSignature(tool, args), changed: screen.changed, screenFingerprint: screen.fingerprint })
      : guardNoteScreen(state, screen.fingerprint));
  }

  /** A write that ran. Typing is part of an approved send, so it keeps the grant; any other write voids it. A turn with
   * no gate has nothing to void. */
  noteWrite(turn: ConfirmTurn, kind: WriteKind): void {
    const held = this.turns.get(confirmKey(turn));
    if (held && held.generation === (turn.generation ?? "")) held.gate.noteWrite(kind);
  }

  /** Forget one turn: its grants, its refusals, its step count and its loop guard. A phone's last screen is not the
   * turn's to drop. */
  reset(turn: ConfirmTurn): void {
    this.turns.delete(confirmKey(turn));
    this.resetGuard(turn);
  }

  /** Forget one turn's loop guard alone, for a turn that ended or a phone that was dropped. */
  resetGuard(turn: ConfirmTurn): void {
    this.guards.delete(confirmKey(turn));
  }

  /** Whether this very turn already holds a gate: a spent grant or a remembered refusal has something to age out. */
  private held(turn: ConfirmTurn): boolean {
    const state = this.turns.get(confirmKey(turn));
    return state !== undefined && state.generation === (turn.generation ?? "");
  }

  private state(turn: ConfirmTurn): { generation: string; gate: ConfirmGate; step: number; cards: Set<string> } {
    const key = confirmKey(turn);
    const generation = turn.generation ?? "";
    let state = this.turns.get(key);
    // A grant belongs to the turn that made it: the next turn in this conversation starts with none.
    if (state && state.generation !== generation) state = undefined;
    if (state) this.turns.delete(key);
    else state = { generation, gate: new ConfirmGate(), step: 0, cards: new Set() };
    this.turns.set(key, state);
    evict(this.turns, MAX_CONFIRM_TURNS);
    return state;
  }

  /** The guard this turn built, or a fresh one when the turn is not the one the entry was made for. */
  private guardState(turn: GuardTurn): GuardState {
    const held = this.guards.get(confirmKey(turn));
    return held && held.generation === turn.generation ? held.state : freshGuard();
  }

  /** Keep the guard where the next call of this turn finds it; the oldest turn's entry is dropped past the cap. */
  private keepGuard(turn: GuardTurn, state: GuardState): void {
    const key = confirmKey(turn);
    this.guards.delete(key);
    this.guards.set(key, { generation: turn.generation, state });
    evict(this.guards, MAX_CONFIRM_TURNS);
  }
}

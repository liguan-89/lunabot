// A second, narrower layer over a phone screen write. The outgoing-action card asks the person once per tool call, which
// cannot tell "tap Back" from "tap 付款"; this one reads the control's own words with shared/irreversible.ts, so an
// irreversible step waits for an approval of that exact step, which the gate then uses up. The state lives here, per turn
// and per phone, so host.ts stays the wiring.
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
} from "../../shared/irreversible.ts";

/** The pair one gate belongs to: an approval never crosses threads or bots. */
export interface ConfirmTurn { threadId: string; botId: string }

/** The fields of one phone element this module keeps: the gate's, plus the ref a tap names it by. */
type PhoneScreenElement = ControlElement & { ref?: string | null };

/** One screen as the phone sent it, narrowed: no image bytes and no field this module does not read. */
interface PhoneScreen {
  /** The Android package in front, as `topPackage` on the wire. */
  topPackage: string | null;
  elements: PhoneScreenElement[];
  /** The display height in the same pixels as bounds, when the answer said it. */
  height?: number;
}

/** How many turns keep a gate and how many phones keep a screen; the oldest is dropped past this, so a long-lived
 * server does not grow without bound. */
export const MAX_CONFIRM_TURNS = 200;
export const MAX_CONFIRM_SCREENS = 200;

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
  return { topPackage, elements, ...(height !== undefined ? { height } : {}) };
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

/** The smallest element whose bounds hold the point: the one the phone's own tap would reach. */
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
 * The first step of a PHONE_UI_RUN that the word list names, read against the screen as it stands now. Later steps act on
 * screens this server never saw, so a target that is not on the current screen cannot be judged and is left alone.
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
        : op === "swipe" && (command.direction === "left" || command.direction === "right") ? { interaction: "swipe", screenTexts }
          : null;
    if (input && classifyControl(input)) return input;
  }
  return null;
}

function controlOn(tool: string, args: Record<string, unknown>, screen: PhoneScreen | null): ControlInput | null {
  const name = tool.replace(MCP_PREFIX, "");
  const screenTexts = screenTextsOf(screen);
  if (name === "PHONE_UI_TAP") return { element: elementNamed(screen, args), screenTexts };
  // The classifier cannot hit-test a point, so resolve the element under it first, as its own doc says to.
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
 */
export function controlFor(tool: string, args: Record<string, unknown>, observeResult: unknown): ControlInput | null {
  return controlOn(tool, args, screenOf(observeResult));
}

/** Every tool whose answer is a full snapshot: the reads that take one, and the driving actions that answer with the
 * screen they ended on. A query's answer carries only the elements it matched, so it is not one. */
const SCREEN_ANSWERS: ReadonlySet<string> = new Set([
  "PHONE_UI_OBSERVE", "PHONE_UI_SCREENSHOT", "PHONE_UI_RUN", "PHONE_UI_WAIT",
  "PHONE_UI_LAUNCH", "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_SCROLL",
  "PHONE_UI_SWIPE", "PHONE_UI_KEY", "PHONE_UI_BACK",
]);

/** Does this tool's answer carry the whole screen as it now is? Recording anything else would shrink the screen the next
 * control is read against. */
export function recordsScreen(tool: string): boolean {
  return SCREEN_ANSWERS.has(tool.replace(MCP_PREFIX, ""));
}

/** The sentence the bot reads: which control, which kind, and that the person must be asked first. */
function refusal(input: ControlInput, hit: IrreversibleHit, permit: Permit): string {
  const what = input.interaction === "enter" ? "pressing the enter key"
    : input.interaction === "swipe" ? "this swipe"
      : `tapping ${hit.matched}`;
  const why = permit.result === "mismatch" ? ` (${permit.reason})` : "";
  return `Not run: ${what} is the irreversible action "${hit.action}", and the person has not approved this exact step${why}. ` +
    "Ask the person first with the confirmation tool, then try the step again.";
}

/** What one pending screen control needs: run it, or stop and ask. `allowed` means the gate used up the approval. */
export type ConfirmCheck =
  | { result: "proceed" }
  | { result: "allowed"; hit: IrreversibleHit }
  | { result: "refused"; hit: IrreversibleHit; reason: string };

function evict<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

/** The per-turn gates and the last screen each phone showed. One lives for the server's lifetime; both maps evict their
 * oldest entry, so a long-lived server does not grow without bound. */
export class PhoneConfirms {
  private readonly turns = new Map<string, { gate: ConfirmGate; step: number }>();
  private readonly screens = new Map<string, PhoneScreen>();

  /** How many turns hold a gate; a test reads it to see the bound hold. */
  get size(): number {
    return this.turns.size;
  }

  /** Record the screen an answer carries; an answer with no element list leaves the last screen alone. */
  noteScreen(phoneKey: string, result: unknown): void {
    const screen = screenOf(result);
    if (!screen) return;
    this.screens.delete(phoneKey);
    this.screens.set(phoneKey, screen);
    evict(this.screens, MAX_CONFIRM_SCREENS);
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
    const state = this.state(turn);
    const screen = this.screens.get(phoneKey) ?? null;
    const input = controlOn(tool, args, screen);
    if (!input) return { result: "proceed" };
    // Every control the gate looks at is a step, so a grant cannot outlive the next few taps.
    state.step += 1;
    const hit = classifyControl(input);
    if (!hit) return { result: "proceed" };
    const permit = state.gate.permits(hit, viewOf(screen), state.step);
    return permit.result === "allowed"
      ? { result: "allowed", hit }
      : { result: "refused", hit, reason: refusal(input, hit, permit) };
  }

  /** Forget one turn: its grants, its refusals and its step count. A phone's last screen is not the turn's to drop. */
  reset(turn: ConfirmTurn): void {
    this.turns.delete(confirmKey(turn));
  }

  private state(turn: ConfirmTurn): { gate: ConfirmGate; step: number } {
    const key = confirmKey(turn);
    let state = this.turns.get(key);
    if (state) this.turns.delete(key);
    else state = { gate: new ConfirmGate(), step: 0 };
    this.turns.set(key, state);
    evict(this.turns, MAX_CONFIRM_TURNS);
    return state;
  }
}

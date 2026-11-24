// Experience replay: a route is one path that worked, saved so a later request that looks like the same task can be
// replayed instead of planned again. This file is the pure core — template extraction, matching, what a run may
// save, and the path's fingerprint. Ported from Mika's core/replay and core/agent/LearnGate (Apache-2.0), stripped
// to what a phone screen actually gives us.
//
// Left to the storage and replay layers that come later: the codec and file store, `withCurrentToolNames` (renamed
// tools in routes saved before a rename), `replacing`/`samePath` (keeping counters when a template is re-saved),
// the share envelope, `RouteAnchors.elementAt` (coordinate hit-testing during replay), and everything that calls a
// model. A caller that must pick between several fitting routes gets `needsDecision` and supplies its own
// classifier; nothing here sends a request.
import { createHash, randomUUID } from "node:crypto";

import { isPhoneToolName, isPhoneWrite, phoneToolCapability } from "./phone-apps.ts";

/** One element of a PHONE_UI_OBSERVE result, the fields a route may recognise it by. */
export interface ScreenElement {
  ref?: string | null;
  /** For an editable element this is what was typed into it, not a label. */
  text?: string | null;
  description?: string | null;
  viewId?: string | null;
  /** The element's class name; it stands in for Mika's role. */
  class?: string | null;
  /** Left, top, right, bottom in the phone display's pixels. */
  bounds?: readonly number[] | null;
  clickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  password?: boolean;
}

/** A screen as the run saw it: the foreground package and its elements. */
export interface ScreenSnapshot {
  packageName?: string | null;
  elements: readonly ScreenElement[];
}

/**
 * How a route recognises an element on a later run: refs only live for one observation, so role, name, resource
 * id, bounds and which same-shaped element on the screen it was. An empty name means the name is not part of the
 * match; a name of `{1}` means it comes from that run's request slot.
 */
export interface Selector {
  /** Mika's role, from the observe `class`. */
  role: string;
  name: string;
  resourceId: string | null;
  bounds: number[];
  ordinal: number;
  /** These features found exactly one element on the screen it was recorded from. */
  uniqueAtRecord: boolean;
}

/** One screen's fixed frame: the foreground package and at most MAX_ANCHORS stable texts. */
export interface Anchors {
  packageName: string | null;
  texts: string[];
}

/** One replayable action. `args` has the observation's refs dropped and slot values written as `{n}`. Unlike Mika's
 * `argsJson` string this is a plain object, so a caller never has to parse it twice and the fingerprint can
 * canonicalise it. */
export interface RouteStep {
  tool: string;
  args: Record<string, unknown>;
  target: Selector | null;
  before: Anchors;
  after: Anchors;
}

/** One path that worked. `template` is the request with its variable parts replaced by `{1}`, `{2}`… */
export interface Route {
  id: string;
  template: string;
  slots: number;
  packages: string[];
  /** Package → version, as Mika keeps it; the recorder leaves it empty until storage learns to fill it. */
  appVersions: Record<string, string>;
  steps: RouteStep[];
  successes: number;
  consecutiveMisses: number;
  /** The step a replay last diverged at; null when it never diverged. */
  missStep: number | null;
  disabled: boolean;
  lastUsedMs: number;
}

export const MAX_ROUTE_STEPS = 60;
export const MAX_ROUTE_BYTES = 64 * 1024;
export const MAX_SLOTS = 8;
export const MAX_CHARS = 8_000;
/** How many splits the slot search may try before giving up instead of guessing. */
export const MAX_SEARCH = 128;
/** How many stable texts one screen's anchors keep. */
export const MAX_ANCHORS = 3;

/** Kotlin's Char.isWhitespace, which the ported trimming, blank and squash rules were written against: JS's \s,
 * plus the information separators, and without the byte-order mark. */
const WHITESPACE_CODES: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const SLOT_PATTERN = /\{(\d+)\}/g;
/** A typed value the recorder masks; a password box is never recorded. */
const MASK = "***";
const MIN_SLOT = 2;
const MIN_SIMILARITY = 0.3;
const TYPE_TEXT_TOOLS: ReadonlySet<string> = new Set(["PHONE_UI_TYPE"]);
const LAUNCH_TOOLS: ReadonlySet<string> = new Set(["PHONE_UI_LAUNCH"]);
const OPENS: ReadonlySet<string> = new Set(["PHONE_UI_LAUNCH"]);
/** Numbers, times and money change between runs, so they are never anchors or stored names. */
const VOLATILE = /[0-9０-９¥￥$€£%]/;
const USER_SCREEN_LINE = /^\[\[screen:[A-Za-z0-9_-]{1,64}\]\]$/;

function isWhitespace(character: string): boolean {
  return WHITESPACE_CODES.has(character.codePointAt(0)!);
}

/** Kotlin's String.trim(), so a name trimmed here matches one trimmed there. */
function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text[start]!)) start += 1;
  while (end > start && isWhitespace(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

function isBlank(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isWhitespace(text[index]!)) return false;
  }
  return true;
}

function squash(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (!isWhitespace(character)) out += character;
  }
  return out;
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let at = text.indexOf(value);
  while (at >= 0) {
    count += 1;
    at = text.indexOf(value, at + 1);
  }
  return count;
}

interface Hole {
  /** Where the placeholder starts in the template. */
  index: number;
  text: string;
  /** The `n` in `{n}`. */
  id: number;
}

/** The template's placeholders, or null when one is not an int (Kotlin's `toIntOrNull`). */
function holesOf(template: string): Hole[] | null {
  // matchAll copies the global regex's lastIndex, so leave it at zero however this pattern was last used.
  SLOT_PATTERN.lastIndex = 0;
  const holes: Hole[] = [];
  for (const match of template.matchAll(SLOT_PATTERN)) {
    const id = Number(match[1]!);
    if (!Number.isInteger(id) || id > 2_147_483_647) return null;
    holes.push({ index: match.index!, text: match[0], id });
  }
  return holes;
}

/** The template cut at its placeholders, with JS split's empty first and last pieces kept. */
function partsOf(template: string, holes: readonly Hole[]): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const hole of holes) {
    parts.push(template.slice(last, hole.index));
    last = hole.index + hole.text.length;
  }
  parts.push(template.slice(last));
  return parts;
}

/**
 * The values a route's template takes out of a request, in `{1}`, `{2}`… order, as the exact original characters
 * (surrounding whitespace included). Null when the request is not this sentence: too long, too many slots, slot
 * ids not exactly 1..slots, a blank fixed segment between slots, an ambiguous split, or a search that ran out of
 * budget. Boundaries are matched against the original text, never after whitespace normalisation.
 */
export function routeSlots(route: Pick<Route, "template" | "slots">, request: string): string[] | null {
  const { template, slots: slotCount } = route;
  if (request.length > MAX_CHARS || template.length > MAX_CHARS) return null;
  if (!Number.isInteger(slotCount) || slotCount < 0 || slotCount > MAX_SLOTS) return null;
  const holes = holesOf(template);
  if (!holes) return null;
  const ids = holes.map((hole) => hole.id).sort((a, b) => a - b);
  // The recorder numbers slots by the order they were first used, not by their position in the sentence; a
  // duplicate or missing number is not guessed at.
  if (ids.length !== slotCount || ids.some((id, index) => id !== index + 1)) return null;
  const parts = partsOf(template, holes);
  if (holes.length === 0) return squash(request) === squash(parts[0]!) ? [] : null;
  if (!request.startsWith(parts[0]!)) return null;
  // A blank fixed segment would make the boundary invisible; hand the sentence back to the model.
  if (parts.slice(1, -1).some(isBlank)) return null;

  const values = Array.from({ length: slotCount }, () => "");
  const matches: string[][] = [];
  let searched = 0;
  let exhausted = false;
  const visit = (hole: number, start: number): void => {
    if (matches.length > 1 || exhausted) return;
    if (++searched > MAX_SEARCH) {
      exhausted = true;
      return;
    }
    if (hole === holes.length) {
      if (start === request.length && validSlots(template, values, request)) matches.push([...values]);
      return;
    }
    const next = parts[hole + 1]!;
    if (next === "") {
      // The last segment is empty: the slot runs to the end, and a slot is never empty.
      if (start < request.length) {
        values[holes[hole]!.id - 1] = request.slice(start);
        visit(hole + 1, request.length);
      }
      return;
    }
    let end = request.indexOf(next, start + 1);
    while (end >= 0 && matches.length <= 1 && !exhausted) {
      values[holes[hole]!.id - 1] = request.slice(start, end);
      visit(hole + 1, end + next.length);
      end = request.indexOf(next, end + 1);
    }
  };
  visit(0, parts[0]!.length);
  return exhausted || matches.length !== 1 ? null : matches[0]!;
}

/** Mika's RouteMatcher.validated: every value is one non-blank piece of the request, and filling the template
 * back with them gives the request (whitespace ignored). This is what stops "张三" being cut out of "张三丰". */
function validSlots(template: string, values: readonly string[], request: string): boolean {
  if (values.some((value) => isBlank(value) || occurrences(request, value) !== 1)) return false;
  const filled = fillTemplate(template, values);
  return filled !== null && squash(filled) === squash(request);
}

/** The request a template becomes with these values: the inverse of routeSlots. Null when the template's slot
 * ids are not exactly 1..values.length. */
export function fillTemplate(template: string, values: readonly string[]): string | null {
  const holes = holesOf(template);
  if (!holes || holes.length !== values.length) return null;
  const ids = holes.map((hole) => hole.id).sort((a, b) => a - b);
  if (ids.some((id, index) => id !== index + 1)) return null;
  let filled = "";
  let last = 0;
  for (const hole of holes) {
    filled += template.slice(last, hole.index) + values[hole.id - 1]!;
    last = hole.index + hole.text.length;
  }
  return filled + template.slice(last);
}

/** The values a bare template takes out of a request; the template's hole count is its slot count. */
export function templateValues(template: string, request: string): string[] | null {
  const holes = holesOf(template);
  if (!holes) return null;
  return routeSlots({ template, slots: holes.length }, request);
}

/** Does this route apply to the request? Its template must yield slot values, and a route a replay gave up on
 * (disabled) never applies, whatever its template says. */
export function matchesRoute(route: Pick<Route, "template" | "slots" | "disabled">, request: string): boolean {
  return !route.disabled && routeSlots(route, request) !== null;
}

/** Character bigrams, lower-cased and whitespace-free; a placeholder cuts the pairs around it. */
function bigrams(text: string): Set<string> {
  const chars = text.toLowerCase();
  const pairs = new Set<string>();
  let kept = "";
  for (let index = 0; index < chars.length; index += 1) {
    if (!isWhitespace(chars[index]!)) kept += chars[index]!;
  }
  for (let index = 0; index + 1 < kept.length; index += 1) {
    const pair = kept[index]! + kept[index + 1]!;
    if (!pair.includes("\u0000")) pairs.add(pair);
  }
  return pairs;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const pair of left) if (right.has(pair)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The routes that both look like the request and whose template fits it, best first. The shortlist is Mika's:
 * disabled routes are out, a route stays when its template is at least MIN_SIMILARITY like the request (bigrams,
 * placeholders cut) or when it touches one of `packages` (the apps the caller already matched to the task), and
 * the most similar come first with input order breaking ties. The shortlist is cut to `limit` before fitting,
 * exactly as Mika's matcher does; the caller then asks needsDecision.
 */
export function routeCandidates(
  routes: readonly Route[],
  request: string,
  options: { limit?: number; packages?: readonly string[] } = {},
): Route[] {
  const limit = Math.max(0, options.limit ?? 5);
  const packages = new Set(options.packages ?? []);
  const goalPairs = bigrams(request);
  return routes
    .filter((route) => !route.disabled)
    .map((route, index) => ({
      route,
      index,
      similarity: jaccard(goalPairs, bigrams(route.template.replace(SLOT_PATTERN, "\u0000"))),
    }))
    .filter(({ route, similarity }) => similarity >= MIN_SIMILARITY || route.packages.some((pkg) => packages.has(pkg)))
    .sort((left, right) => right.similarity - left.similarity || left.index - right.index)
    .slice(0, limit)
    .map(({ route }) => route)
    .filter((route) => routeSlots(route, request) !== null);
}

/** More than one route fits: a classifier has to pick, because replaying either is a guess. */
export function needsDecision(candidates: readonly Route[]): boolean {
  return candidates.length > 1;
}

/** Does the request carry a user-screen attachment? Its meaning is on that screen, so a route keyed by the words
 * alone would not match next time. The marker is Mika's `[[screen:<id>]]` line, kept so an imported route's gate
 * reads the same; a caller that knows the goal carries a screen should pass `userScreen` to `learnable` instead. */
export function hasUserScreenAttachment(goal: string): boolean {
  return goal.split(/\r\n|\r|\n/).some((line) => USER_SCREEN_LINE.test(trimWhitespace(line)));
}

/** What one run's final state says about learning. */
export interface LearnGateInput {
  /** Learning is on for this bot; absent means on. */
  routesOn?: boolean;
  /** The judge's outcome; only exactly "done" is learned, never partial, impossible or unknown. */
  outcome: string;
  /** Routes are rebuilt from the persisted run, so there must be one. */
  runId?: string | null;
  /** The person's request, as typed. */
  goal: string;
  /** The request carries a user-screen attachment (however the caller marks it). */
  userScreen?: boolean;
  /** Values the final answer could not confirm; any of them blocks learning. */
  unconfirmed?: readonly unknown[];
  /** The final answer was doubtful. */
  doubtful?: boolean;
}

/** May this run be learned at all? Ported from LearnGate.done plus LearnGate.shouldSaveRoute. */
export function learnable(input: LearnGateInput): boolean {
  return (
    input.routesOn !== false &&
    input.outcome === "done" &&
    typeof input.runId === "string" &&
    input.runId.length > 0 &&
    input.userScreen !== true &&
    !hasUserScreenAttachment(input.goal) &&
    (input.unconfirmed?.length ?? 0) === 0 &&
    input.doubtful !== true
  );
}

/** One action the run took, in the shape the recorder needs: a phone write, or an observation it made. */
export interface RouteAction {
  tool: string;
  args: Record<string, unknown>;
  /** The element it acted on, as the observation that named it returned it. */
  target?: ScreenElement | null;
  /** The whole observation the target came from; ordinal and uniqueness are counted over it. */
  screen?: readonly ScreenElement[] | null;
  before?: Anchors;
  after?: Anchors;
  /** The tool's result, which decides whether the action did anything. */
  result: Record<string, unknown>;
  /** The step's observation was cut short (a batch that stopped early). */
  incomplete?: boolean;
  /** The screen was protected (FLAG_SECURE) while this ran. */
  protected?: boolean;
}

export interface RouteRun extends LearnGateInput {
  actions: readonly RouteAction[];
  nowMs: number;
  /** The caller's own reason the run must not be learned: a takeover, a confirmation, a payment, a waiting state,
   * a browser or sandbox capability. Ported from RouteRecorder.spoils, which the caller has the events to decide. */
  spoiled?: boolean;
  /** Which tool names a route may replay; defaults to the phone screen writes. */
  routable?: (tool: string) => boolean;
  /** Which tool names make a run unreplayable even though they are not steps. Defaults to every tool that is not
   * a phone read or a replayable phone write; a caller whose reads are harmless (a knowledge lookup) can widen it. */
  barred?: (tool: string) => boolean;
  /** The route's id; defaults to a fresh UUID. */
  id?: string;
}

/**
 * Phone writes a route must not replay. The clipboard and file sharing reach past the screen. DO_EACH nests its
 * steps in `body`, where the recorder's ref-stripping and sensitive-text sweep do not look, so a stored one could
 * pin what was typed: its turns are simply never learned.
 */
const NOT_REPLAYED: ReadonlySet<string> = new Set(["PHONE_CLIPBOARD_SET", "PHONE_FILE_SHARE", "PHONE_UI_DO_EACH"]);

/** The phone writes a route can replay: the screen controls, never observing, the clipboard or file sharing. */
export function isReplayablePhoneTool(tool: string): boolean {
  return isPhoneToolName(tool) && phoneToolCapability(tool) === "phoneUi" && isPhoneWrite(tool) && !NOT_REPLAYED.has(tool);
}

/** A phone tool that only reads: observing, waiting, a screenshot, the clipboard, a file. It is not a step, and
 * using one does not make the run unreplayable. */
export function isPhoneReadTool(tool: string): boolean {
  return isPhoneToolName(tool) && !isPhoneWrite(tool);
}

/** Did the write do something? Ok and the screen changed, a type the phone reports as typed, or an app came to the
 * front (the port already waited for its target). Mika's port reported `ok` and `verification: "match"`; ours
 * reports `isError` (or an `error` message) and `typed`, so both spellings are read. */
export function effectiveWrite(tool: string, result: Record<string, unknown>): boolean {
  if (result.ok === false || result.isError === true || typeof result.error === "string") return false;
  if (result.changed === true || result.verification === "match") return true;
  if (TYPE_TEXT_TOOLS.has(tool) && result.typed === true) return true;
  return OPENS.has(tool) && result.changed !== false;
}

/** Can this text be an anchor or a stored name? Short, and no number, time or money in it. */
export function stableAnchor(text: string): boolean {
  const trimmed = trimWhitespace(text);
  return trimmed.length >= 1 && trimmed.length <= 12 && !VOLATILE.test(trimmed);
}

function roleOf(element: ScreenElement): string {
  return element.class ?? "";
}

/** The element's visible label, for comparing two elements on one screen. */
function observedName(element: ScreenElement): string {
  return trimWhitespace(element.text ?? "") || trimWhitespace(element.description ?? "");
}

/**
 * The name a selector may store. Our observe reports a field's `text` as what was typed into it, and unlike
 * Mika's element it carries no separate hint flag, so an editable element is never named by its text: role,
 * resourceId, bounds and ordinal identify it. That can lose a field's hint, but it can never persist what the
 * person typed.
 */
function storedName(element: ScreenElement): string {
  if (element.editable) return "";
  const name = observedName(element);
  return name !== "" && stableAnchor(name) ? name : "";
}

/** How a route recognises this element later, counted over the observation it came from. */
export function selectorFor(element: ScreenElement, screen: readonly ScreenElement[] = [element]): Selector {
  const name = storedName(element);
  const same = (other: ScreenElement): boolean => {
    if (roleOf(other) !== roleOf(element)) return false;
    if ((other.viewId ?? null) !== (element.viewId ?? null)) return false;
    return name === "" || observedName(other) === observedName(element);
  };
  // Elements before the target, counted the way Mika's takeWhile does: an element the caller passed outside its
  // own screen counts every same-shaped element, since nothing precedes it there.
  const at = screen.indexOf(element);
  const before = at < 0 ? screen : screen.slice(0, at);
  return {
    role: roleOf(element),
    name,
    resourceId: element.viewId ?? null,
    bounds: boundsOf(element) ?? [],
    ordinal: before.filter(same).length,
    uniqueAtRecord: screen.filter(same).length === 1,
  };
}

/** A tool result that says the screen was shielded, or the field was a password box. */
function protectedResult(result: Record<string, unknown>): boolean {
  return result.protected === true || result.state === "protected";
}

function boundsOf(element: ScreenElement): number[] | null {
  const bounds = element.bounds;
  return bounds && bounds.length === 4 ? [...bounds] : null;
}

function inside(element: ScreenElement, container: ScreenElement): boolean {
  if (element === container) return false;
  const inner = boundsOf(element);
  const outer = boundsOf(container);
  if (!inner || !outer) return false;
  return inner[0]! >= outer[0]! && inner[1]! >= outer[1]! && inner[2]! <= outer[2]! && inner[3]! <= outer[3]!;
}

/** Mika's list roles, matched inside our observe class names (androidx.recyclerview.widget.RecyclerView,
 * android.widget.ListView), since a phone screen reports a class where Mika had a role. */
const LIST_ROLE = /list|grid|recycler|scroll/;

function isContainer(element: ScreenElement): boolean {
  return element.scrollable === true || LIST_ROLE.test(roleOf(element).toLowerCase());
}

/**
 * The texts that can anchor a screen: the fixed frame (titles, tabs, buttons), in screen order and without
 * repeats, those with a resource id first. List entries and anything inside a scrollable container are content
 * (contacts, messages, products), and an editable field's text is what the person wrote, so neither is an anchor.
 */
export function anchorTexts(snapshot: ScreenSnapshot): string[] {
  const containers = snapshot.elements.filter(isContainer);
  return snapshot.elements
    .filter(
      (element) =>
        element.editable !== true &&
        !isContainer(element) &&
        !containers.some((container) => inside(element, container)) &&
        stableAnchor(observedName(element)),
    )
    .map((element, index) => ({ element, index, noId: (element.viewId ?? null) === null }))
    .sort((left, right) => Number(left.noId) - Number(right.noId) || left.index - right.index)
    .map(({ element }) => observedName(element))
    .filter((text, index, all) => all.indexOf(text) === index);
}

/** The anchors before an action: the foreground package and the screen's stable texts, without the target's own
 * label (that is what the selector is for). */
export function anchorsFrom(snapshot: ScreenSnapshot | null | undefined, target?: ScreenElement | null): Anchors {
  if (!snapshot) return { packageName: null, texts: [] };
  const self = target ? observedName(target) : "";
  return {
    packageName: snapshot.packageName ?? null,
    texts: anchorTexts(snapshot)
      .filter((text) => text !== self)
      .slice(0, MAX_ANCHORS),
  };
}

/** The anchors after an action: the texts that were not on the screen before it. */
export function anchorsAfter(before: ScreenSnapshot | null | undefined, after: ScreenSnapshot): Anchors {
  const old = new Set(before ? anchorTexts(before) : []);
  return {
    packageName: after.packageName ?? null,
    texts: anchorTexts(after)
      .filter((text) => !old.has(text))
      .slice(0, MAX_ANCHORS),
  };
}

/**
 * Turn a finished run into a route, or null when it must not be learned. The run is saved only when it is
 * learnable (outcome exactly "done", a run id, a goal without a user-screen attachment), no step was incomplete or
 * protected, no action used a tool a route cannot replay, and at least one write did something. Typed text becomes
 * a slot only when it is one unique piece of the request; anything else (a fixed word, something the person was
 * asked for, a password) makes the whole route unsaveable. Selectors never carry an editable element's text.
 */
export function recordRoute(run: RouteRun): Route | null {
  if (!learnable(run)) return null;
  if (run.spoiled) return null;
  const routable = run.routable ?? isReplayablePhoneTool;
  const barred = run.barred ?? ((tool: string) => !routable(tool) && !isPhoneReadTool(tool));
  const actions = run.actions;
  // A cut-short step or a shielded screen (FLAG_SECURE) anywhere in the run means its recording cannot be trusted.
  if (actions.some((action) => action.incomplete || action.protected || protectedResult(action.result))) return null;
  // A route only replays the screen: a run that also drove the browser, a shell or a sandbox is not replayable.
  // Reading the phone (observing, waiting, a screenshot) is not a step and does not spoil the run; a phone write
  // that cannot be replayed (the clipboard, a shared file) does.
  if (actions.some((action) => barred(action.tool))) return null;
  const acts = actions.filter((action) => routable(action.tool) && effectiveWrite(action.tool, action.result));
  if (acts.length === 0 || acts.length > MAX_ROUTE_STEPS) return null;

  // Slot values are numbered by first use. A value that is short, absent from the request, or there more than
  // once cannot be swapped for a later request's value, so it stops the whole route.
  const slots: string[] = [];
  const bind = (value: string): boolean => {
    if (slots.includes(value)) return true;
    if (trimWhitespace(value).length < MIN_SLOT || occurrences(run.goal, value) !== 1) return false;
    slots.push(value);
    return true;
  };

  const args: Record<string, unknown>[] = [];
  const targets: (Selector | null)[] = [];
  const targetNames: (string | null)[] = [];
  for (const action of acts) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action.args)) {
      if (key !== "ref" && key !== "snapshotId" && key !== "target") cleaned[key] = value;
    }
    if (TYPE_TEXT_TOOLS.has(action.tool)) {
      const text = cleaned.text;
      if (typeof text !== "string") return null;
      if (text === MASK) return null;
      // Mika required its port to say "not a password box" before recording a type. Ours refuses a password
      // field outright and marks it `password` in the observation, so that flag is the evidence; a result that
      // says `secret` still counts. With neither a flag nor the element itself, treat it as a password box.
      if (action.result.secret === true || action.target?.password === true) return null;
      if (action.result.secret !== false && action.target == null) return null;
      if (!bind(text)) return null;
      cleaned.text = `{${slots.indexOf(text) + 1}}`;
    }
    args.push(cleaned);

    const element = action.target ?? null;
    const observed = element ? observedName(element) : null;
    let selector = element ? selectorFor(element, action.screen ?? [element]) : null;
    if (selector && selector.name !== "") {
      const name = selector.name;
      if (run.goal.includes(name)) {
        if (!bind(name)) return null;
        selector = { ...selector, name: `{${slots.indexOf(name) + 1}}` };
      } else if (slots.some((value) => name.includes(value))) {
        // The label has this run's parameter inside it ("send to 张三"): do not recognise by name.
        selector = { ...selector, name: "", uniqueAtRecord: false };
      }
    }
    targets.push(selector);
    targetNames.push(observed);
  }

  // Slot spans must not overlap: a short value swallowed by a longer one could not be swapped on its own.
  const spans = slots.map((value) => {
    const start = run.goal.indexOf(value);
    return { start, end: start + value.length - 1 };
  });
  for (let left = 0; left < spans.length; left += 1) {
    for (let right = left + 1; right < spans.length; right += 1) {
      if (spans[left]!.start <= spans[right]!.end && spans[right]!.start <= spans[left]!.end) return null;
    }
  }

  // A step's label can be recorded before the text that turns out to be a slot ("发送" + the message), so the
  // check above cannot see every slot value yet. Sweep again now that all of them are known: a label that
  // carries this run's parameter is not stored, or the route would pin the person's words into the next run.
  for (let index = 0; index < targets.length; index += 1) {
    const selector = targets[index]!;
    if (!selector || selector.name === "" || selector.name.startsWith("{")) continue;
    if (slots.some((value) => selector.name.includes(value))) targets[index] = { ...selector, name: "", uniqueAtRecord: false };
  }

  let template = run.goal;
  const ordered = spans.map((span, index) => ({ span, index })).sort((a, b) => b.span.start - a.span.start);
  for (const { span, index } of ordered) {
    template = template.slice(0, span.start) + `{${index + 1}}` + template.slice(span.end + 1);
  }

  // Anchors are the screen's fixed frame: no numbers, not the target itself, and nothing that carries a slot
  // value, so a route saved from one request does not pin that request's words into the next run.
  const cleanAnchors = (anchors: Anchors | undefined, targetName: string | null): Anchors => ({
    packageName: anchors?.packageName ?? null,
    texts: (anchors?.texts ?? [])
      .map(trimWhitespace)
      .filter((text) => stableAnchor(text) && text !== (targetName ?? "") && !slots.some((value) => text.includes(trimWhitespace(value))))
      .filter((text, index, all) => all.indexOf(text) === index)
      .slice(0, MAX_ANCHORS),
  });

  const steps: RouteStep[] = acts.map((action, index) => ({
    tool: action.tool,
    args: args[index]!,
    target: targets[index]!,
    before: cleanAnchors(action.before, targetNames[index]!),
    after: cleanAnchors(action.after, null),
  }));

  const packages: string[] = [];
  for (const action of acts) {
    // Our launch tool names the target `app` (the Android package); Mika's named it `package`.
    const launched = LAUNCH_TOOLS.has(action.tool) ? (action.args.app ?? action.args.package) : null;
    if (typeof launched === "string") packages.push(launched);
  }
  for (const action of acts) {
    for (const anchors of [action.before, action.after]) {
      if (anchors?.packageName) packages.push(anchors.packageName);
    }
  }

  const route: Route = {
    id: run.id ?? randomUUID(),
    template,
    slots: slots.length,
    packages: packages.filter((pkg, index) => packages.indexOf(pkg) === index),
    appVersions: {},
    steps,
    successes: 0,
    consecutiveMisses: 0,
    missStep: null,
    disabled: false,
    lastUsedMs: run.nowMs,
  };
  // A divergence from Mika: a route is only worth saving if its template can be read back from this request. Two
  // slots that end up next to each other leave no fixed text between them, which routeSlots refuses; saving such a
  // route would store something that can never match again.
  if (routeSlots(route, run.goal) === null) return null;
  return encodedBytes(route) <= MAX_ROUTE_BYTES ? route : null;
}

function encodedBytes(route: Route): number {
  return new TextEncoder().encode(JSON.stringify(route)).length;
}

/** JSON with object keys sorted at every depth, so the same call hashes the same however it was built. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function selectorKey(selector: Selector | null): string {
  if (!selector) return "";
  return [
    selector.role,
    selector.name,
    selector.resourceId ?? "",
    selector.bounds.join(","),
    String(selector.ordinal),
    String(selector.uniqueAtRecord),
  ].join("\u0000");
}

/**
 * A stable identity for the path a route takes: its template, slot count, packages, and each step's tool,
 * arguments and selector, hashed with SHA-256. Anchors, counters, the id and the last-used time are left out, so
 * the same path saved twice on different devices is recognised (Mika's samePath semantics). Arguments are
 * canonicalised, so key order does not matter.
 */
export function routeFingerprint(route: Route): string {
  const hash = createHash("sha256");
  const line = (...parts: string[]): void => {
    hash.update(parts.join("\u0000"));
    hash.update("\n");
  };
  line(...[...route.packages].sort());
  line(route.template, String(route.slots));
  for (const step of route.steps) line(step.tool, canonicalJson(step.args), selectorKey(step.target));
  return hash.digest("hex");
}

/** Steps one injected route renders before an ellipsis; a route can hold 60, the prompt should not. */
export const ROUTE_PROMPT_MAX_STEPS = 20;

const argText = (args: Record<string, unknown>, key: string): string | null => {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : null;
};

function routeStepLine(step: RouteStep, args: Record<string, unknown>, name: string | null): string {
  const target = [name && `"${name}"`, step.target?.resourceId && `id ${step.target.resourceId}`].filter(Boolean).join(" ") || JSON.stringify(args);
  switch (step.tool) {
    case "PHONE_UI_LAUNCH": return `launch ${argText(args, "app") ?? target}`;
    case "PHONE_UI_TAP": return `tap ${target}`;
    case "PHONE_UI_TAP_AT": return `tap at ${String(args.x)},${String(args.y)}`;
    case "PHONE_UI_TYPE": return `type ${JSON.stringify(argText(args, "text") ?? "")}`;
    case "PHONE_UI_SCROLL": return `scroll ${argText(args, "direction") ?? "down"}${name ? ` on "${name}"` : ""}`;
    case "PHONE_UI_SWIPE": return `swipe ${argText(args, "direction") ?? ""}`;
    case "PHONE_UI_KEY": return `press ${argText(args, "key") ?? "enter"}`;
    case "PHONE_UI_BACK": return "back";
    case "PHONE_UI_WAIT": return `wait ${argText(args, "mode") ?? "change"}${argText(args, "text") ? ` for ${JSON.stringify(argText(args, "text"))}` : ""}`;
    case "PHONE_UI_RUN": return `run ${JSON.stringify(args.commands ?? args)}`;
    case "PHONE_OPEN_LINK": return `open ${argText(args, "url") ?? target}`;
    case "PHONE_SHARE_TEXT": return `share ${JSON.stringify(argText(args, "text") ?? "")}${argText(args, "app") ? ` into ${argText(args, "app")}` : ""}`;
    case "PHONE_UI_AFTER_TASK": return `after the task, ${argText(args, "mode") ?? "keep"} the app`;
    default: return `${step.tool} ${JSON.stringify(args)}`;
  }
}

/**
 * The system-prompt text for one route that matched this turn's request, with its slot holes filled from the
 * request, so the model reads the concrete steps rather than the placeholders. The replay itself is the bot's own
 * PHONE_UI calls — this text only tells it the path exists: a stored ref is never reused, each step names a text
 * or a view id the run finds again on the current screen, and a route whose first screen is not in front does not
 * apply. Empty for a route with no steps.
 */
export function routePrompt(route: Route, request: string): string {
  if (route.steps.length === 0) return "";
  const values = templateValues(route.template, request) ?? [];
  const fill = (text: string): string => text.replace(SLOT_PATTERN, (hole, digits: string) => values[Number(digits) - 1] ?? hole);
  const argsOf = (step: RouteStep): Record<string, unknown> =>
    Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value]));
  const shown = route.steps.slice(0, ROUTE_PROMPT_MAX_STEPS);
  const start = shown[0]!.before.packageName ?? route.packages[0] ?? null;
  const lines = shown.map((step, index) => `   ${index + 1}. ${routeStepLine(step, argsOf(step), step.target?.name ? fill(step.target.name) : null)}`);
  const more = route.steps.length > shown.length ? `\n   … ${route.steps.length - shown.length} more steps` : "";
  return ` A path that worked before exists for a request like this one ("${route.template}").${start ? ` It starts on ${start}.` : ""}` +
    ` Replay its steps with PHONE_UI_RUN rather than inventing them: a stored ref is never reused, and each command finds its target again on the screen it runs on.` +
    ` Its steps:\n${lines.join("\n")}${more}` +
    ` If the screen in front is not the one the path starts on, or a step's target is nowhere to find, the path does not apply — work it out from the screen yourself.`;
}

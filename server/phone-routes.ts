// Adapted from Mika's RouteRecorder, RouteStore and ActionRecorder (Apache-2.0).
//
// Phone routes: the recording and storage layer over shared/route-replay.ts. A run is offered here as it happens, one
// call at a time; finish turns it into a route only when the judge said "done", every call was a phone read or a
// replayable phone write, and nothing about the run spoils it. Routes live in
// DATA_DIR/phone-routes/<owner>/<id>.json — folders 0700, files 0600, written atomically, bounded per owner and per
// route, and a file that does not parse is skipped rather than fatal.
//
// Typed text never reaches a file. The pure core slots what the person's request holds and refuses the rest; an editable
// element is never named by its text; and a finished route is scanned once more for anything a call typed or a field
// held. A pairing code or a password is covered twice over: a field marked `password` stops the run, and any text with a
// digit in it is neither an anchor nor a stored name (shared/route-replay.ts's `stableAnchor`), so a code cannot be kept
// even when it was displayed rather than typed. File contents are never route material at all: a share is not a
// replayable step, and a read's answer is not one either.
//
// Nothing here throws at the caller: a turn that cannot be recorded, or a disk that refuses the write, leaves the turn
// exactly as it was.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import {
  MAX_ROUTE_BYTES,
  MAX_ROUTE_STEPS,
  MAX_SLOTS,
  anchorsAfter,
  anchorsFrom,
  isPhoneReadTool,
  isReplayablePhoneTool,
  learnable,
  matchesRoute,
  recordRoute,
  routeCandidates,
  routeFingerprint,
  type Anchors,
  type Route,
  type RouteAction,
  type ScreenElement,
  type ScreenSnapshot,
} from "../shared/route-replay.ts";
import { writeFileAtomic } from "./atomic.ts";

/** What one turn is, for the recorder: whose routes it may extend, and whether it may be learned at all. */
export interface RouteTurn {
  /** The owner whose routes this run may extend; null when the turn is not provably the owner's, so nothing is kept. */
  ownerKey: string | null;
  threadId: string;
  botId: string;
  /** Names the turn, so a new turn in one conversation never joins the last one's buffer. */
  generation?: string;
  /** The person's request, as typed. */
  goal: string;
  /** A route is rebuilt from a run, so there must be one; `learnable` refuses without it. */
  runId?: string | null;
  /** Learning is on for this bot; absent means on. */
  routesOn?: boolean;
  /** The request carries a screen attachment, so its words alone would not find this route next time. */
  userScreen?: boolean;
}

/** One call the turn made, as the host saw it. */
export interface RouteStepNote {
  tool: string;
  args: Record<string, unknown>;
  /** The element it acted on, as the observation that named it returned it. */
  target?: ScreenElement | null;
  /** The whole observation the target came from — its elements, or the snapshot with its package — so the selector's
   * ordinal and uniqueness count over it and the step knows the app in front. */
  screen?: ScreenSnapshot | readonly ScreenElement[] | null;
  /** The screen this call's answer carried, when it carried one. */
  after?: ScreenSnapshot | null;
  /** The screen before it; defaults to `screen`, then to the screen the previous note left. */
  before?: ScreenSnapshot | null;
  /** The call's result: whether it did anything, and whether the screen was shielded. */
  result: Record<string, unknown>;
  /** The step's observation was cut short (a batch that stopped early). */
  incomplete?: boolean;
  /** The screen was protected (FLAG_SECURE) while this ran. */
  protected?: boolean;
}

/** How one run ended, as the caller judged it. */
export interface RouteOutcome {
  /** The judge's word for how the run ended; only exactly "done" is learned. */
  outcome: string;
  /** Values the final answer could not confirm; any of them blocks learning. */
  unconfirmed?: readonly unknown[];
  doubtful?: boolean;
  /** The caller's own reason not to learn: a takeover, a payment, a confirmation, a browser, a waiting state. */
  spoiled?: boolean;
}

export const PHONE_ROUTE_LIMITS = {
  /** Routes one owner keeps; past this the least recently used is dropped. */
  maxRoutesPerOwner: 50,
  /** Bytes one route's file may hold. */
  maxBytesPerRoute: MAX_ROUTE_BYTES,
  /** Calls one turn buffers. A run with more cannot be a route anyway, so it is refused rather than trimmed. */
  maxStepsPerTurn: MAX_ROUTE_STEPS * 4,
  /** Screen elements one turn buffers, across its calls: a screen this wide is refused, not kept in memory. */
  maxElementsPerTurn: 4_000,
  /** Turns with a buffer at once; the oldest is dropped past this, so a long-lived server does not grow without bound. */
  maxTurns: 64,
  /** Texts a finished route is scanned for. Past this the run is refused rather than half-checked. */
  maxSensitiveTexts: 128,
} as const;

export type PhoneRouteLimits = { -readonly [Key in keyof typeof PHONE_ROUTE_LIMITS]: number };

export interface PhoneRoutesOptions {
  /** Where the owner folders live, normally `join(DATA_DIR, "phone-routes")`. */
  root: string;
  now?: () => number;
  /** Off unless a caller turns it on, so a server that never wired recording writes nothing. */
  enabled?: boolean;
  limits?: Partial<PhoneRouteLimits>;
}

/** A route's file name, minus `.json`. A route's id is a UUID; anything else is not a file this store wrote. */
const ROUTE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An element whose wording says it holds a secret: a password box, a one-time code or a pairing code, in either
 * language the interface may be in. */
const SECRET_FIELD = /(password|passcode|pass[-_ ]?code|otp|one[-_ ]?time|verification code|pairing code|\bpin\b|密码|口令|验证码|校验码|动态码|配对码)/i;

/** One call, with its anchors worked out at note time: snapshots are large, and only the anchors are ever written. */
interface BufferedStep {
  tool: string;
  args: Record<string, unknown>;
  target: ScreenElement | null;
  screen: readonly ScreenElement[] | null;
  before: Anchors;
  after: Anchors;
  result: Record<string, unknown>;
  incomplete: boolean;
  protected: boolean;
}

interface TurnBuffer {
  steps: BufferedStep[];
  /** The screen the last note left, which is the next call's `before`. */
  screen: ScreenSnapshot | null;
  /** Texts an editable element held or a call typed: none of them may reach a file. */
  sensitive: Set<string>;
  /** Elements buffered so far, across every call's screen. */
  elements: number;
  /** Too many calls, elements or texts to check: the run is refused rather than recorded in part. */
  overflow: boolean;
  /** The run showed a password box or a pairing-code field: nothing about it is kept, whatever the rest of it says. */
  secret: boolean;
}

/** An owner key this store can name a folder after: the desktop's `owner` and a Cloud home's `p_…` both fit, and nothing
 * with a separator, a dot or a space does. */
const OWNER_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** The folder one owner's routes live in, under the store's root. A key the server computed is used as it is, so the
 * store reads the way it is documented; anything else is hashed, so a key that is a person's address or number — or one
 * carrying a path — never becomes a path. */
export function ownerDirectoryName(ownerKey: string): string {
  if (OWNER_KEY.test(ownerKey)) return ownerKey;
  return `o-${createHash("sha256").update(ownerKey, "utf8").digest("hex").slice(0, 32)}`;
}

/** One turn's buffer is its thread, its bot and its generation: a new turn never inherits the last one's calls. */
function turnKey(turn: RouteTurn): string {
  return `${turn.threadId}\u0000${turn.botId}\u0000${turn.generation ?? ""}`;
}

/**
 * A call's arguments without the observation refs it named: a ref lives for one observation only, so a stored one would
 * point at nothing on the next run. The pure core drops the top-level `ref`, `snapshotId` and `target`; a run's own
 * steps carry a ref each, so those are dropped here as well, leaving the run to find each target again by its text,
 * resource id or role.
 */
function withoutStaleRefs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "PHONE_UI_RUN" || !Array.isArray(args.commands)) return args;
  return {
    ...args,
    commands: args.commands.map((command) => {
      if (!command || typeof command !== "object" || Array.isArray(command)) return command;
      const { ref: _ref, ...rest } = command as Record<string, unknown>;
      return rest;
    }),
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The elements of a screen a caller passed, whether it kept the whole snapshot or only its list. */
function elementsOf(screen: ScreenSnapshot | readonly ScreenElement[] | null | undefined): readonly ScreenElement[] {
  if (!screen) return [];
  return Array.isArray(screen) ? screen : (screen as ScreenSnapshot).elements;
}

/** A screen the caller passed, as the snapshot `anchorsFrom` reads; a bare element list keeps the package unknown. */
function snapshotOf(screen: ScreenSnapshot | readonly ScreenElement[] | null | undefined): ScreenSnapshot | null {
  if (!screen) return null;
  return Array.isArray(screen) ? { packageName: null, elements: screen } : (screen as ScreenSnapshot);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boundsOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  return value.every((part) => typeof part === "number" && Number.isFinite(part)) ? value as number[] : null;
}

/** One element of an answer, or null when the phone sent something that is not one: its JSON is not trusted. */
function elementOf(value: unknown): ScreenElement | null {
  const element = recordOf(value);
  if (!element) return null;
  return {
    ref: textOf(element.ref),
    text: textOf(element.text),
    description: textOf(element.description),
    viewId: textOf(element.viewId),
    // The phone writes the class name as `class`; a narrowed screen may already carry it as className.
    class: textOf(element.className) ?? textOf(element.class),
    bounds: boundsOf(element.bounds),
    clickable: element.clickable === true,
    editable: element.editable === true,
    scrollable: element.scrollable === true,
    password: element.password === true,
  };
}

/**
 * The screen a phone answer carries, or null when it carries no element list (a launch, an OCR answer, a failure). The
 * answer is either the screen itself or, for PHONE_UI_RUN, the `screen` it holds. This is the host's one adapter: it
 * turns the wire answer into what `note` reads, without reaching into confirm.ts's private narrowing.
 */
export function screenFromAnswer(result: unknown): ScreenSnapshot | null {
  const record = recordOf(result);
  if (!record) return null;
  const screen = recordOf(record.screen) ?? record;
  if (!Array.isArray(screen.elements)) return null;
  const elements = screen.elements.map(elementOf).filter((element): element is ScreenElement => element !== null);
  return { packageName: textOf(screen.topPackage), elements };
}

/** The element an observation names by ref: the ref in the call's arguments, found on the screen that named it. Null when
 * the call names no ref or the screen holds none. A tap's answer is the screen after it, so the host passes the last
 * observation's elements, not the answer's. */
export function elementByRef(elements: readonly ScreenElement[] | null | undefined, ref: unknown): ScreenElement | null {
  if (typeof ref !== "string" || ref === "") return null;
  return elements?.find((element) => element.ref === ref) ?? null;
}

/** The smallest element whose bounds hold the point, as a tap there would reach; on a tie the clickable one wins. This is
 * Mika's `RouteAnchors.elementAt`, which the pure core left to the layer that has the screen. */
export function elementAtPoint(elements: readonly ScreenElement[] | null | undefined, x: unknown, y: unknown): ScreenElement | null {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  let found: ScreenElement | null = null;
  let area = Number.POSITIVE_INFINITY;
  for (const element of elements ?? []) {
    const bounds = element.bounds;
    if (!bounds || bounds.length !== 4) continue;
    if (x < bounds[0]! || y < bounds[1]! || x > bounds[2]! || y > bounds[3]!) continue;
    const size = (bounds[2]! - bounds[0]!) * (bounds[3]! - bounds[1]!);
    if (size < area || (size === area && element.clickable === true && found?.clickable !== true)) {
      found = element;
      area = size;
    }
  }
  return found;
}

/** The element a step acted on, from the call's own arguments: a ref, or a point a coordinate tap names. */
function targetFor(tool: string, args: Record<string, unknown>, elements: readonly ScreenElement[]): ScreenElement | null {
  if (tool === "PHONE_UI_TAP_AT") return elementAtPoint(elements, args.x, args.y);
  return elementByRef(elements, args.ref);
}

/**
 * The recorder and the store in one: `note` appends a call to the turn's buffer, `finish` turns a finished run into a
 * route and writes it, and `match` offers the routes that fit a request. One instance serves the whole server; the
 * owner is named on every call, so two people never see each other's routes.
 */
export class PhoneRoutes {
  private readonly root: string;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly limits: PhoneRouteLimits;
  private readonly turns = new Map<string, TurnBuffer>();

  constructor(options: PhoneRoutesOptions) {
    this.root = options.root;
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled === true;
    const limits = { ...PHONE_ROUTE_LIMITS, ...options.limits };
    this.limits = {
      maxRoutesPerOwner: Math.max(1, limits.maxRoutesPerOwner),
      maxBytesPerRoute: Math.max(1, limits.maxBytesPerRoute),
      maxStepsPerTurn: Math.max(1, limits.maxStepsPerTurn),
      maxElementsPerTurn: Math.max(1, limits.maxElementsPerTurn),
      maxTurns: Math.max(1, limits.maxTurns),
      maxSensitiveTexts: Math.max(1, limits.maxSensitiveTexts),
    };
  }

  /**
   * Append one call to the turn's buffer. The screen before the call is the one the previous note left unless the caller
   * passes its own, and the anchors are worked out here, while both screens are in hand. A call that is not a phone tool
   * at all is buffered too: it is what makes `finish` refuse the run, since a route replays the phone's screen alone.
   */
  note(turn: RouteTurn, step: RouteStepNote): void {
    if (!this.enabled || turn.ownerKey === null) return;
    try {
      const key = turnKey(turn);
      let buffer = this.turns.get(key);
      if (!buffer) {
        buffer = { steps: [], screen: null, sensitive: new Set(), elements: 0, overflow: false, secret: false };
        this.turns.set(key, buffer);
        while (this.turns.size > this.limits.maxTurns) {
          const oldest = this.turns.keys().next();
          if (oldest.done || oldest.value === key) break;
          this.turns.delete(oldest.value);
        }
      }
      const seen = elementsOf(step.screen).length + (step.before?.elements.length ?? 0) + (step.after?.elements.length ?? 0);
      buffer.elements += seen;
      if (buffer.overflow || buffer.steps.length >= this.limits.maxStepsPerTurn || buffer.elements > this.limits.maxElementsPerTurn) {
        buffer.overflow = true;
        return;
      }
      const args = step.args ?? {};
      const observed = snapshotOf(step.screen);
      // The element the call acted on: the one the caller named, or the one its own arguments point at on the screen it
      // was read against (a ref, or the point a coordinate tap names).
      const target = step.target ?? targetFor(step.tool, args, elementsOf(step.screen));
      // The observation the target came from is the screen the call acted on, so it stands in for `before` when the
      // caller has not kept that screen separately; otherwise the screen the previous call left is the one before.
      const before = step.before ?? observed ?? buffer.screen;
      const after = step.after ?? null;
      buffer.steps.push({
        tool: step.tool,
        args: withoutStaleRefs(step.tool, args),
        target,
        screen: elementsOf(step.screen),
        before: anchorsFrom(before, target),
        // With no answer screen the app in front did not change: the call reported nothing to read.
        after: after ? anchorsAfter(before, after) : { packageName: before?.packageName ?? null, texts: [] },
        result: step.result ?? {},
        incomplete: step.incomplete === true,
        protected: step.protected === true,
      });
      if (after) buffer.screen = after;
      this.collectSensitive(buffer, step.tool, args, step);
    } catch {
      // A note that cannot be recorded must not affect the turn.
    }
  }

  /**
   * Turn the turn's buffer into a route, or drop it. The run is learned only when the judge said "done", every call was
   * a phone read or a replayable phone write, and the finished route holds none of the texts an editable element held.
   * The buffer is dropped whatever happens, and no failure reaches the caller.
   */
  finish(turn: RouteTurn, outcome: RouteOutcome): Route | null {
    const key = turnKey(turn);
    const buffer = this.turns.get(key);
    this.turns.delete(key);
    if (!this.enabled || !buffer || turn.ownerKey === null) return null;
    try {
      if (buffer.overflow || buffer.secret || buffer.steps.length === 0) return null;
      // A route is found by its template, so a request with no words to match has nothing to save.
      if (turn.goal.trim() === "") return null;
      const gate = {
        routesOn: turn.routesOn,
        outcome: outcome.outcome,
        runId: turn.runId,
        goal: turn.goal,
        userScreen: turn.userScreen,
        unconfirmed: outcome.unconfirmed,
        doubtful: outcome.doubtful,
      };
      if (!learnable(gate)) return null;
      // Reading the phone is not a step and does not spoil the run; a write a route cannot replay (the clipboard, a
      // shared file) or a call that is not a phone tool at all does, and so does a call the phone cut short.
      if (buffer.steps.some((step) => !isReplayablePhoneTool(step.tool) && !isPhoneReadTool(step.tool))) return null;
      if (buffer.steps.some((step) => step.incomplete || step.protected)) return null;
      const actions: RouteAction[] = buffer.steps.map((step) => ({
        tool: step.tool,
        args: step.args,
        target: step.target,
        screen: step.screen,
        before: step.before,
        after: step.after,
        result: step.result,
        incomplete: step.incomplete,
        protected: step.protected,
      }));
      const route = recordRoute({ ...gate, spoiled: outcome.spoiled, actions, nowMs: this.now() });
      if (!route) return null;
      // The pure core already keeps an editable element's text out of names and anchors; this is the guard that says so,
      // and it also catches a PHONE_UI_RUN whose own commands type something, which the core does not slot.
      if (this.repeatsText(route, buffer.sensitive)) return null;
      if (Buffer.byteLength(JSON.stringify(route), "utf8") > this.limits.maxBytesPerRoute) return null;
      return this.persist(turn.ownerKey, route);
    } catch {
      return null;
    }
  }

  /**
   * The routes that fit the request, best first. The shortlist is Mika's: disabled routes out, the most similar first,
   * those touching one of `packages` kept even when the words alone are not similar enough, and only those whose
   * template actually fits the request's words. Empty for an owner with none, a request that fits none, or a recorder
   * that is off.
   */
  match(ownerKey: string | null, request: string, limit = 5, packages: readonly string[] = []): Route[] {
    if (!this.enabled || ownerKey === null || limit <= 0) return [];
    try {
      return routeCandidates(this.readOwner(ownerKey), request, { limit, packages })
        .filter((route) => matchesRoute(route, request));
    } catch {
      return [];
    }
  }

  /** One owner's routes, the most recently used first. A file that does not parse is left out, never thrown over. */
  list(ownerKey: string | null): Route[] {
    if (!this.enabled || ownerKey === null) return [];
    try {
      return this.readOwner(ownerKey).sort((left, right) => right.lastUsedMs - left.lastUsedMs);
    } catch {
      return [];
    }
  }

  /** Delete one route. False when there was none, the recorder is off, or the disk refused; never fatal. */
  forget(ownerKey: string | null, id: string): boolean {
    if (!this.enabled || ownerKey === null) return false;
    return this.removeFile(ownerKey, id);
  }

  /**
   * What a call typed, and what any editable element on a screen it read held. Only an editable element's `text` counts:
   * our observe reports that as what was typed into it, while its `description` is the field's hint, which is the
   * interface's own wording and may well be an anchor elsewhere on the screen.
   *
   * A password box, or a field whose own wording calls it a code, marks the whole run: a pairing code or a one-time
   * code is short and may hold no digit at all, so `stableAnchor` alone cannot keep it out of a name.
   */
  private collectSensitive(buffer: TurnBuffer, tool: string, args: Record<string, unknown>, step: RouteStepNote): void {
    const add = (value: unknown): void => {
      if (typeof value !== "string" || value === "") return;
      if (buffer.sensitive.size >= this.limits.maxSensitiveTexts) {
        buffer.overflow = true;
        return;
      }
      buffer.sensitive.add(value);
    };
    if (tool === "PHONE_UI_TYPE") add(args.text);
    // A run carries its own steps, and a type among them is typed text the pure core does not slot.
    const commands = args.commands;
    if (Array.isArray(commands)) {
      for (const command of commands) {
        if (command && typeof command === "object" && (command as { op?: unknown }).op === "type") {
          add((command as { text?: unknown }).text);
        }
      }
    }
    for (const elements of [elementsOf(step.screen), step.before?.elements, step.after?.elements]) {
      for (const element of elements ?? []) {
        if (element.password === true) buffer.secret = true;
        if (element.editable !== true) continue;
        add(element.text);
        if (SECRET_FIELD.test(`${element.text ?? ""} ${element.description ?? ""} ${element.viewId ?? ""}`)) buffer.secret = true;
      }
    }
  }

  /** Does any string the route would write hold one of these texts? A one-character text is compared whole, since a
   * substring search for it would match a coordinate. */
  private repeatsText(route: Route, texts: ReadonlySet<string>): boolean {
    if (texts.size === 0) return false;
    const stored: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") stored.push(value);
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
    };
    walk(route);
    for (const text of texts) {
      const whole = text.length < 2;
      for (const value of stored) if (whole ? value === text : value.includes(text)) return true;
    }
    return false;
  }

  /** Write the route, replacing the copy of the same path, then drop the least recently used routes past the cap. */
  private persist(ownerKey: string, route: Route): Route | null {
    const dir = this.ownerDir(ownerKey, true);
    if (!dir) return null;
    const existing = this.readOwner(ownerKey);
    const fingerprint = routeFingerprint(route);
    const samePath = existing.find((other) => routeFingerprint(other) === fingerprint);
    // Saving the same path again keeps what the old copy learned about it; a different path for one sentence is a real
    // alternative, so it stays (Mika's putReplacing dropped it).
    const kept: Route = samePath
      ? {
          ...route,
          successes: Math.max(route.successes, samePath.successes),
          consecutiveMisses: samePath.consecutiveMisses,
          missStep: samePath.missStep,
          disabled: samePath.disabled,
        }
      : route;
    writeFileAtomic(join(dir, `${kept.id}.json`), JSON.stringify(kept), { mode: 0o600 });
    const survivors: Route[] = [];
    for (const old of existing) {
      if (old.id === kept.id) continue;
      if (routeFingerprint(old) === fingerprint) this.removeFile(ownerKey, old.id);
      else survivors.push(old);
    }
    this.evict(ownerKey, [...survivors, kept], kept.id);
    return kept;
  }

  /** Drop the least recently used routes until the owner is back under the cap; the route just written is never one. */
  private evict(ownerKey: string, routes: Route[], keepId: string): void {
    const excess = routes.length - this.limits.maxRoutesPerOwner;
    if (excess <= 0) return;
    const victims = routes
      .filter((route) => route.id !== keepId)
      .sort((left, right) => left.lastUsedMs - right.lastUsedMs);
    for (const route of victims.slice(0, excess)) this.removeFile(ownerKey, route.id);
  }

  private removeFile(ownerKey: string, id: string): boolean {
    if (!ROUTE_ID.test(id)) return false;
    const dir = this.ownerDir(ownerKey, false);
    if (!dir) return false;
    try {
      unlinkSync(join(dir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /** One owner's folder, checked to be a directory inside the store: a planted link is not followed. */
  private ownerDir(ownerKey: string, create: boolean): string | null {
    if (ownerKey.trim() === "") return null;
    const dir = join(this.root, ownerDirectoryName(ownerKey));
    try {
      if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(dir).isDirectory()) return null;
      const real = realpathSync(dir);
      const inside = relative(realpathSync(this.root), real);
      return inside && !inside.startsWith("..") && !isAbsolute(inside) ? real : null;
    } catch {
      return null;
    }
  }

  private readOwner(ownerKey: string): Route[] {
    const dir = this.ownerDir(ownerKey, false);
    if (!dir) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const routes: Route[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!ROUTE_ID.test(id)) continue;
      const route = this.readFile(join(dir, name), id);
      if (route) routes.push(route);
    }
    return routes;
  }

  private readFile(path: string, id: string): Route | null {
    try {
      const stat = lstatSync(path);
      // A symbolic link is not a file this store wrote, and a route past the ceiling cannot be one either.
      if (!stat.isFile() || stat.size > this.limits.maxBytesPerRoute) return null;
      return routeFrom(JSON.parse(readFileSync(path, "utf8")), id);
    } catch {
      return null;
    }
  }
}

/** A stored route, or null when the file is not one: a hand edit or a half-written copy must not become a route. */
function routeFrom(value: unknown, id: string): Route | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Partial<Route>;
  if (route.id !== id) return null;
  if (typeof route.template !== "string" || route.template.length === 0) return null;
  if (!Number.isInteger(route.slots) || route.slots! < 0 || route.slots! > MAX_SLOTS) return null;
  if (!Array.isArray(route.packages) || !route.packages.every((pkg) => typeof pkg === "string")) return null;
  if (!route.appVersions || typeof route.appVersions !== "object" || Array.isArray(route.appVersions)) return null;
  if (!Array.isArray(route.steps) || route.steps.length === 0 || route.steps.length > MAX_ROUTE_STEPS) return null;
  for (const step of route.steps) {
    if (!step || typeof step !== "object") return null;
    if (typeof step.tool !== "string" || !step.args || typeof step.args !== "object" || Array.isArray(step.args)) return null;
    if (!anchorsOk(step.before) || !anchorsOk(step.after)) return null;
    if (step.target !== null && (typeof step.target !== "object" || typeof step.target.name !== "string")) return null;
  }
  if (!Number.isInteger(route.successes) || route.successes! < 0) return null;
  if (!Number.isInteger(route.consecutiveMisses) || route.consecutiveMisses! < 0) return null;
  if (route.missStep !== null && !Number.isInteger(route.missStep)) return null;
  if (typeof route.disabled !== "boolean" || !Number.isFinite(route.lastUsedMs)) return null;
  return route as Route;
}

function anchorsOk(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const anchors = value as Anchors;
  return (anchors.packageName === null || typeof anchors.packageName === "string")
    && Array.isArray(anchors.texts)
    && anchors.texts.every((text) => typeof text === "string");
}

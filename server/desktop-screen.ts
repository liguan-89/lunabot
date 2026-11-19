// This computer's own screen, for a paired phone: capture through the desktop's Cua Driver, and act on it through the
// same driver's `scope: "desktop"` input path. The driver connection is the one the desktop app hands this server at
// launch (desktop-computer.ts), so a server the app did not start has nothing to capture and nothing to click — the
// same rule that already governs a bot driving this Mac.
//
// Deliberately narrow. The phone may capture the whole display and may click, type, scroll and press keys at a point.
// It may not name an app, a window, a file, a command line, a URL or an element token: those are the bot's tools, and a
// phone that could reach them would be a second agent, not a viewer with hands.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wholeScreenshot } from "./container-computer.ts";
import { augmentedPath } from "./env-path.ts";
import type { LocalComputerConnection } from "./local-computer.ts";

/** One capture: the picture the phone draws, and the frame an action's x/y must be expressed in. */
export interface DesktopScreenFrame {
  png: string;
  mime: "image/png" | "image/jpeg";
  /** Pixels in [png]; what the phone's touch maps against. */
  imageWidth: number;
  imageHeight: number;
  /**
   * The driver's own desktop pixels — `screenshot_original_width/height`, which on a retina screen is twice the
   * logical point size. Actions are sent in these, not in points: the driver converts them itself, and a point-sized
   * coordinate lands at half the intended place.
   */
  screenWidth: number;
  screenHeight: number;
}

/** The actions a phone may take. Anything else is refused before a driver call is made. */
export const DESKTOP_SCREEN_ACTIONS = ["click", "double_click", "scroll", "type_text", "press_key", "hotkey"] as const;
export type DesktopScreenAction = (typeof DESKTOP_SCREEN_ACTIONS)[number];

export interface DesktopScreenRequest {
  action: DesktopScreenAction;
  /** Screen points, from the frame's screenWidth/screenHeight. */
  x?: number;
  y?: number;
  text?: string;
  /** `up` | `down` | `left` | `right` for scroll; a key name for press_key. */
  key?: string;
  /** `cmd`/`shift`/`option`/`ctrl` for press_key and click, or the chord for hotkey. */
  modifiers?: string[];
  /** Lines or pages for scroll. */
  amount?: number;
}

const ACTION_LIMITS = {
  /** The driver's own cap on one type_text call. */
  text: 4_000,
  modifiers: 4,
  amount: 30,
} as const;

const KEY_NAME = /^[A-Za-z0-9_+\-.]{1,40}$/;
const MODIFIER = new Set(["cmd", "command", "shift", "option", "alt", "ctrl", "control"]);

/** The socket the driver answers on, out of the `--socket` argument the app's descriptor carries. */
export function desktopScreenSocket(connection: LocalComputerConnection): string | null {
  const at = connection.args.indexOf("--socket");
  const socket = at >= 0 ? connection.args[at + 1] : undefined;
  return typeof socket === "string" && socket.startsWith("/") ? socket : null;
}

/** One driver call, with a timeout that kills the child rather than leaving it to outlive the request. */
function callDriver(
  connection: LocalComputerConnection,
  socket: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(connection.command, ["call", tool, JSON.stringify(args), "--socket", socket], {
      shell: false,
      env: { ...process.env, ...connection.env, PATH: augmentedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`the computer did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      // A driver that keeps talking past this point is already failing; the cap keeps one call bounded.
      if (stdout.length < 1_000_000) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.on("error", (error) => finish(new Error(`could not start the computer helper: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(driverFailure(stdout, stderr, code)));
    });
  });
}

/** The driver's own sentence when it has one, so the phone shows what went wrong rather than an exit code. */
function driverFailure(stdout: string, stderr: string, code: number | null): string {
  for (const text of [stdout, stderr]) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        message?: unknown;
        hint?: unknown;
        suggestion?: unknown;
        escalation?: { reason?: unknown };
        code?: unknown;
      };
      const candidates = [
        typeof parsed.error === "string" ? parsed.error : parsed.error?.message,
        parsed.message,
        // A refusal names itself in `code` and explains itself in `hint`; without these the phone saw a bare "}".
        parsed.hint,
        parsed.suggestion,
        parsed.escalation?.reason,
        parsed.code,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 400);
      }
    } catch {
      // Not JSON: fall through to the text itself.
    }
    const line = text.split("\n").map((row) => row.trim()).filter((row) => row && row !== "}" && row !== "{").at(-1);
    if (line) return line.slice(0, 400);
  }
  return `the computer helper exited with code ${code ?? "unknown"}`;
}

/**
 * Capture the whole display. `maxImageDimension` caps the long edge — the phone draws a few hundred points wide, so a
 * full 3420 px retina frame would be several megabytes for no visible gain.
 *
 * The driver writes PNG only, and a retina PNG is ~1.6 MB of base64: several times what one SSE frame should carry.
 * macOS's own `sips` re-encodes it to JPEG (a tenth of the bytes at the same size) and is skipped on other platforms,
 * where the PNG is sent as-is rather than failing the capture.
 */
export async function captureDesktopScreen(
  connection: LocalComputerConnection,
  { maxImageDimension = 900, timeoutMs = 20_000 }: { maxImageDimension?: number; timeoutMs?: number } = {},
): Promise<DesktopScreenFrame> {
  const socket = desktopScreenSocket(connection);
  if (!socket) throw Object.assign(new Error("this computer's helper has no address to ask"), { status: 409 });
  const scratch = mkdtempSync(join(tmpdir(), "lunabot-screen-"));
  const file = join(scratch, "screen.png");
  try {
    const cap = Math.max(0, Math.min(4096, Math.round(maxImageDimension)));
    const { stdout } = await callDriver(
      connection,
      socket,
      "get_desktop_state",
      { max_image_dimension: cap, screenshot_out_file: file },
      timeoutMs,
    );
    const facts = JSON.parse(stdout) as Record<string, unknown>;
    // The driver's `scope: "desktop"` input path takes DESKTOP PIXELS, not logical points: it divides by the backing
    // scale itself (a click at 3400,2200 reports "screen-point (1700,1100)"). Sending points lands every action at half
    // its intended place on a retina screen, which is exactly what a phone's tap looked like — off by 2×.
    const screenWidth = Number(facts.screenshot_original_width ?? facts.screen_width);
    const screenHeight = Number(facts.screenshot_original_height ?? facts.screen_height);
    const imageWidth = Number(facts.screenshot_width);
    const imageHeight = Number(facts.screenshot_height);
    if (![screenWidth, screenHeight, imageWidth, imageHeight].every((n) => Number.isFinite(n) && n > 0)) {
      throw Object.assign(new Error("the computer returned a screen without its size"), { status: 502 });
    }
    const jpeg = process.platform === "darwin" ? await sipsToJpeg(file, scratch) : null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(jpeg ?? file);
    } catch {
      throw Object.assign(new Error("the computer returned no picture"), { status: 502 });
    }
    const checked = wholeScreenshot(bytes);
    if (!checked.ok) throw Object.assign(new Error("the computer returned an incomplete picture"), { status: 502 });
    return {
      png: bytes.toString("base64"),
      mime: checked.mime === "image/jpeg" ? "image/jpeg" : "image/png",
      imageWidth,
      imageHeight,
      screenWidth,
      screenHeight,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The JPEG beside [png], or null when the platform tool is missing or refused — the PNG is then used unchanged. */
function sipsToJpeg(png: string, scratch: string): Promise<string | null> {
  const out = join(scratch, "screen.jpg");
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "60", png, "--out", out], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        resolve(readFileSync(out).length > 512 ? out : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** What one action is allowed to say, or a sentence naming the first thing wrong with it. */
export function desktopScreenRefusal(request: Partial<DesktopScreenRequest>): string | null {
  const action = request.action;
  if (!action || !(DESKTOP_SCREEN_ACTIONS as readonly string[]).includes(action)) {
    return `an action must be one of ${DESKTOP_SCREEN_ACTIONS.join(", ")}`;
  }
  const point = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (action === "type_text") {
    if (typeof request.text !== "string" || !request.text) return "type_text needs text";
    if (request.text.length > ACTION_LIMITS.text) return `text is longer than ${ACTION_LIMITS.text} characters`;
    return null;
  }
  if (action === "press_key" || action === "hotkey") {
    if (typeof request.key !== "string" || !KEY_NAME.test(request.key)) return `${action} needs a key name`;
  }
  if (action === "click" || action === "double_click" || action === "scroll") {
    if (!point(request.x) || !point(request.y)) return `${action} needs x and y on the screen`;
  }
  if (action === "scroll") {
    if (!["up", "down", "left", "right"].includes(String(request.key))) return "scroll needs a direction";
    if (request.amount !== undefined && !(Number.isInteger(request.amount) && request.amount > 0 && request.amount <= ACTION_LIMITS.amount)) {
      return `amount must be 1..${ACTION_LIMITS.amount}`;
    }
  }
  if (request.modifiers !== undefined) {
    if (!Array.isArray(request.modifiers) || request.modifiers.length > ACTION_LIMITS.modifiers) return "modifiers must be a short list";
    if (!request.modifiers.every((modifier) => MODIFIER.has(String(modifier).toLowerCase()))) {
      return "modifiers may only be cmd, shift, option or ctrl";
    }
  }
  return null;
}

/** One window the driver can see, in logical points, front-most first. */
export interface DesktopWindow {
  pid: number;
  windowId: number;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The window at a point, front-most first, or null over the bare desktop.
 *
 * [windows] carry bounds in logical points and [x]/[y] arrive in desktop pixels, so [scale] (the display's backing
 * factor) converts between them. Getting this wrong is invisible until nothing matches and typing silently falls back
 * to "whatever application is frontmost".
 *
 * This is what makes typing land where the person pointed: the driver's unanchored `type_text` goes to the frontmost
 * application, which is not the window under their finger. `z` is the WindowServer's own order, so the first match is
 * the one they see.
 */
export function windowAtPoint(
  windows: readonly DesktopWindow[],
  x: number,
  y: number,
  scale = 1,
): DesktopWindow | null {
  const pointX = x / (scale > 0 ? scale : 1);
  const pointY = y / (scale > 0 ? scale : 1);
  const ordered = [...windows].sort((a, b) => ((a as { z?: number }).z ?? 0) - ((b as { z?: number }).z ?? 0));
  for (const window of ordered) {
    if (window.width < 8 || window.height < 8) continue;
    if (pointX >= window.x && pointY >= window.y &&
        pointX < window.x + window.width && pointY < window.y + window.height) return window;
  }
  return null;
}

/** The display's backing factor: desktop pixels per logical point. 1 when the driver cannot say. */
async function backingScale(
  connection: LocalComputerConnection,
  socket: string,
  timeoutMs: number,
): Promise<number> {
  try {
    const { stdout } = await callDriver(connection, socket, "get_screen_size", {}, timeoutMs);
    const factor = Number((JSON.parse(stdout) as { scale_factor?: unknown }).scale_factor);
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
}

/** Every on-screen window with a usable rectangle, front-most first. */
async function listWindows(
  connection: LocalComputerConnection,
  socket: string,
  timeoutMs: number,
): Promise<Array<DesktopWindow & { z: number }>> {
  const { stdout } = await callDriver(connection, socket, "list_windows", { on_screen_only: true }, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = (parsed as { windows?: unknown })?.windows;
  if (!Array.isArray(rows)) return [];
  const out: Array<DesktopWindow & { z: number }> = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const bounds = record.bounds as Record<string, unknown> | undefined;
    const pid = Number(record.pid);
    const windowId = Number(record.window_id);
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![pid, windowId, x, y, width, height].every((n) => Number.isFinite(n))) continue;
    // Utility overlays (the Dock's own windows, menu extras) are not things a person taps to type into.
    if (Number(record.layer ?? 0) !== 0) continue;
    out.push({
      pid,
      windowId,
      app: String(record.app_name ?? ""),
      title: String(record.title ?? ""),
      x,
      y,
      width,
      height,
      z: Number(record.z_index ?? Number.MAX_SAFE_INTEGER),
    });
  }
  return out.sort((a, b) => a.z - b.z);
}

/** One action's outcome, plus the window it was aimed at so the caller can remember it for the next keystroke. */
export interface DesktopScreenOutcome {
  ok: true;
  /** The window the action landed on, when one was found. */
  target?: { pid: number; windowId: number };
}

/**
 * Perform one action on the desktop. Coordinates are desktop pixels, which is what the driver's `scope: "desktop"`
 * path takes and divides by the backing scale itself — the phone converts from the picture it drew using the frame's
 * screenWidth/Height.
 *
 * [target] is the window the person last pointed at. Text and keys go there by pid and window id, so they land in that
 * window whether or not it is in front; without it they would follow the driver's rule and go to whatever application
 * is frontmost, which is the bug that made typing feel broken.
 */
export async function performDesktopScreenAction(
  connection: LocalComputerConnection,
  request: DesktopScreenRequest,
  { timeoutMs = 30_000, target }: { timeoutMs?: number; target?: { pid: number; windowId: number } } = {},
): Promise<DesktopScreenOutcome> {
  const refusal = desktopScreenRefusal(request);
  if (refusal) throw Object.assign(new Error(refusal), { status: 400 });
  const socket = desktopScreenSocket(connection);
  if (!socket) throw Object.assign(new Error("this computer's helper has no address to ask"), { status: 409 });
  const at = { x: request.x, y: request.y, scope: "desktop" as const };
  const modifiers = request.modifiers?.map((modifier) => modifier.toLowerCase());
  // Text and keys are aimed at a window, never at "whatever is in front".
  const aimed = target ? { pid: target.pid, window_id: target.windowId } : {};
  switch (request.action) {
    case "click":
    case "double_click": {
      const windows = await listWindows(connection, socket, timeoutMs).catch(() => []);
      const scale = await backingScale(connection, socket, timeoutMs);
      const hit = windowAtPoint(windows, request.x ?? 0, request.y ?? 0, scale);
      // A person clicking a window expects it to come forward and take the keyboard; the driver's desktop click moves
      // the pointer without activating anything, which left every later keystroke going to the wrong application.
      if (hit) {
        await callDriver(connection, socket, "bring_to_front", { pid: hit.pid, window_id: hit.windowId }, timeoutMs)
          .catch(() => undefined);
      }
      await callDriver(connection, socket, "click", {
        ...at,
        // The driver refuses a desktop-scope click over a background app unless told it may take the pointer for that
        // instant; `foreground` is its own documented escalation, and it puts the previous app back afterwards.
        delivery_mode: "foreground",
        ...(request.action === "double_click" ? { count: 2 } : {}),
        ...(modifiers?.length ? { modifier: modifiers } : {}),
        post_action_wait: "none",
      }, timeoutMs);
      return { ok: true, ...(hit ? { target: { pid: hit.pid, windowId: hit.windowId } } : {}) };
    }
    case "scroll": {
      // Scrolling a background window needs no activation; it is aimed at the point.
      await callDriver(connection, socket, "scroll", {
        ...at,
        // Same rule as a click: a wheel event over a background app needs the pointer, which the driver only takes when
        // told to.
        delivery_mode: "foreground",
        direction: request.key,
        amount: request.amount ?? 3,
        post_action_wait: "none",
      }, timeoutMs);
      return { ok: true };
    }
    case "type_text": {
      // Two ways in, tried in order, because they fail on different windows:
      //
      //   1. Aimed at the window: an accessibility write into its focused field. No focus steal, and it answers at once.
      //      Refused when the window's focused element is not a text input — a document window before anything is
      //      clicked in it is exactly that case.
      //   2. At the desktop, into whatever is frontmost. Correct only because a click already brought the tapped window
      //      forward, and that is also what focuses the field the person pointed at.
      if (target) {
        const aimedResult = await callDriver(connection, socket, "type_text", {
          text: request.text,
          ...aimed,
          delivery_mode: "background",
        }, timeoutMs).then(() => null, (error: Error) => error);
        if (!aimedResult) return { ok: true };
      }
      await callDriver(connection, socket, "type_text", {
        text: request.text,
        scope: "desktop",
        delivery_mode: "foreground",
      }, timeoutMs);
      return { ok: true };
    }
    case "press_key": {
      const keyArgs = { key: request.key, ...(modifiers?.length ? { modifiers } : {}) };
      if (target) {
        const aimedResult = await callDriver(connection, socket, "press_key", {
          ...keyArgs,
          ...aimed,
          delivery_mode: "background",
        }, timeoutMs).then(() => null, (error: Error) => error);
        if (!aimedResult) return { ok: true };
      }
      await callDriver(connection, socket, "press_key", {
        ...keyArgs,
        scope: "desktop",
        delivery_mode: "foreground",
      }, timeoutMs);
      return { ok: true };
    }
    case "hotkey":
      await callDriver(connection, socket, "hotkey", {
        keys: [request.key!, ...(modifiers ?? [])],
        ...(target ? { ...aimed, delivery_mode: "background" } : { scope: "desktop", delivery_mode: "foreground" }),
      }, timeoutMs);
      return { ok: true };
  }
}

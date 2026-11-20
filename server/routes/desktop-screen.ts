// A paired phone watching this computer's own screen, and — while it holds the control lease — acting on it.
//
// Two routes, deliberately different in what they need:
//
//   POST /api/bots/:id/desktop/screenshot   watch. No lease: the bot keeps working, which is the point — this is how a
//                                            person sees what the bot is doing. Gated only on the device capability.
//   POST /api/bots/:id/desktop/action       act. Requires the control lease, so the bot's own hands are already refused
//                                            (control-client.ts reads the same record) before a phone click can land.
//
// The capture itself is the desktop's Cua Driver through `desktop-screen.ts`; a server the app did not launch has no
// connection and answers 409, exactly like a bot trying to use this computer.
import { z } from "zod";

import type { ComputerControl } from "../computer-control.ts";
import { captureDesktopScreen, DESKTOP_SCREEN_ACTIONS, performDesktopScreenAction } from "../desktop-screen.ts";
import { desktopComputer, thisComputerNotReady } from "../desktop-computer.ts";
import type { BotRecord, Store } from "../store.ts";
import type { RouteHandler } from "./table.ts";
import { PASS } from "./table.ts";

export interface DesktopScreenRouteDeps {
  store: Pick<Store, "bot">;
  computerControl: Pick<ComputerControl, "ownsLease" | "snapshot">;
  botComputerControlKey(bot: BotRecord): string;
  /** The live driver connection, or null on a server the desktop app did not launch. */
  connection?: () => ReturnType<typeof desktopComputer.connection>;
}

const SCREENSHOT_ROUTE = /^\/api\/bots\/([\w-]+)\/desktop\/screenshot$/;
const ACTION_ROUTE = /^\/api\/bots\/([\w-]+)\/desktop\/action$/;

const ACTION_BODY = z.object({
  action: z.enum(DESKTOP_SCREEN_ACTIONS),
  controlLeaseId: z.string().min(1).max(200),
  x: z.number().finite().min(0).optional(),
  y: z.number().finite().min(0).optional(),
  text: z.string().min(1).max(4_000).optional(),
  key: z.string().min(1).max(40).optional(),
  modifiers: z.array(z.string().min(1).max(16)).max(4).optional(),
  amount: z.number().int().min(1).max(30).optional(),
}).strict();

/** The one sentence a phone sees when this computer cannot be watched; shared by both routes. */
function unavailable(connection: ReturnType<typeof desktopComputer.connection>): { status: number; error: string } | null {
  if (connection) return null;
  if (!desktopComputer.granted()) {
    return {
      status: 409,
      error: "Only the Luna Bot app on this computer can show its screen. Open the app here and try again.",
    };
  }
  return { status: 409, error: thisComputerNotReady() };
}

export function createDesktopScreenRoutes(deps: DesktopScreenRouteDeps): RouteHandler {
  const connection = deps.connection ?? (() => desktopComputer.connection());
  // The window each bot's phone last pointed at. Text and keys go there, so a keystroke lands in the window the person
  // tapped rather than in whatever application happens to be frontmost. In memory: a restart drops it, and the next tap
  // sets it again.
  const aimed = new Map<string, { pid: number; windowId: number }>();
  return async ({ req, res, path, method, json, readBody }) => {
    const shot = path.match(SCREENSHOT_ROUTE);
    const act = path.match(ACTION_ROUTE);
    if (!shot && !act) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const bot = deps.store.bot((shot ?? act)![1]);
    if (!bot) return json(res, 404, { error: "no such bot" });
    const live = connection();
    const problem = unavailable(live);
    if (problem) return json(res, problem.status, { error: problem.error });
    res.setHeader("cache-control", "private, no-store");

    if (shot) {
      // Watch-only: no lease, so the bot keeps working and the person sees it happen.
      const frame = await captureDesktopScreen(live!, { maxImageDimension: 900 });
      return json(res, 200, frame);
    }

    const body = await readBody(req);
    const parsed = ACTION_BODY.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: "that action is not one this screen accepts" });
    const key = deps.botComputerControlKey(bot);
    // The bot's hands are refused the moment this lease is held, so the check is also what keeps the two from fighting.
    if (!deps.computerControl.ownsLease(key, parsed.data.controlLeaseId)) {
      return json(res, 409, { error: "Take control of this computer first" });
    }
    const outcome = await performDesktopScreenAction(live!, parsed.data, { target: aimed.get(bot.id) });
    if (outcome.target) aimed.set(bot.id, outcome.target);
    return json(res, 200, { ok: true, ...(outcome.target ? { target: outcome.target } : {}) });
  };
}

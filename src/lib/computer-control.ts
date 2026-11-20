import type { ComputerHelpRef } from "../../shared/wire";
import { t } from "./i18n";
import { productName } from "@/lib/brand";

export type ComputerControlAction = "take" | "release";

export interface ComputerControlSnapshot {
  held: boolean;
  helpReason: string | null;
  help?: ComputerHelpRef | null;
}

const HELP_PLACES = new Set(["browser", "local", "vm", "cloud"]);

export function parseComputerHelp(value: unknown): ComputerHelpRef | null {
  const ref = value as Partial<Record<keyof ComputerHelpRef, unknown>> | null;
  if (!ref || typeof ref !== "object") return null;
  const { botId, threadId, messageId, site, place } = ref;
  return typeof botId === "string" && typeof threadId === "string" && typeof messageId === "string" &&
    typeof site === "string" && typeof place === "string" && HELP_PLACES.has(place)
    ? { botId, threadId, messageId, site, place: place as ComputerHelpRef["place"] } : null;
}

/** Scoped host tokens can bypass the renderer: take is native-first, release durable-first, and a failure stays held. */
/** Positive-only: loopback callers can influence server state, so a false snapshot never releases the Electron gate. */
/** Take is local-first, release server-first; BrowserPanel owns the same choreography itself. */
export async function transitionComputerControlLease<
  Action extends ComputerControlAction,
  Snapshot extends ComputerControlSnapshot,
>(input: {
  action: Action;
  syncNativeBrowser: boolean;
  requestControl: (action: Action) => Promise<Snapshot>;
  setNativeBrowserControl: (held: boolean) => Promise<boolean>;
}): Promise<Snapshot> {
  const { action, syncNativeBrowser, requestControl, setNativeBrowserControl } = input;
  if (action === "take" && syncNativeBrowser && !(await setNativeBrowserControl(true))) {
    throw new Error(t("computer.err.pauseBrowser", { app: productName() }));
  }
  const snap = await requestControl(action);
  if (snap.held !== (action === "take")) {
    throw new Error(t(action === "take" ? "computer.err.confirmControl" : "computer.err.releaseControl", { app: productName() }));
  }
  if (action === "release" && syncNativeBrowser && !(await setNativeBrowserControl(false))) {
    throw new Error(t("computer.err.browserStillPaused"));
  }
  return snap;
}

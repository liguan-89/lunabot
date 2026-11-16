// The identity the desktop presents to the operating system, in one place: the profile folder Electron names
// after the product, the desktop-entry name GNOME groups windows by, and the URL schemes this build answers.
// The rename moved all three, and each one needs its old spelling honoured so an existing install keeps its
// cookies, its window grouping and the links already handed out.
import { migrateDataDir, migrateUserData } from "./user-data-migration.mjs";

export { migrateDataDir };

/** `lunabot://` is what this build writes; `dexbot://` stays registered so links earlier builds handed out open here. */
export const DESKTOP_PROTOCOLS = ["lunabot", "dexbot"];

/**
 * Runs before anything reads `app.getPath("userData")` and before ready: an installed build from before the
 * rename still keeps its profile in "DEX BOT" (macOS) or "dexbot" (Windows, Linux), and that folder is moved to
 * this build's name once. A source run leaves the person's installed profile alone.
 * @param {{ isPackaged: boolean, getPath(name: string): string }} app
 * @param {(line: string) => void} log
 * @param {{ candidates?: string[], files?: typeof import("node:fs") }} [options] tests name their own folders
 */
export function prepareDesktopProfile(app, log = () => {}, options = {}) {
  if (!app.isPackaged) return null;
  return migrateUserData({ currentDir: app.getPath("userData"), log, ...options });
}

/** GNOME groups a window with its desktop entry only when both identities match; the entry's file name is this. */
export const LINUX_DESKTOP_NAME = "com.lunabot.app.desktop";

/** @param {{ setAsDefaultProtocolClient(scheme: string): boolean }} app */
export function registerDesktopProtocols(app) {
  for (const scheme of DESKTOP_PROTOCOLS) app.setAsDefaultProtocolClient(scheme);
}

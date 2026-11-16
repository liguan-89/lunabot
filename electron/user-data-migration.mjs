// The one-time moves a renamed app must make before anything reads the disk: the window's own profile
// (userData, named after the product) and this computer's bot data folder. Both run once, both are best
// effort: a failed rename leaves the old folder in place rather than starting empty, and nothing here
// throws into startup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The folders an earlier build could have kept the profile in, most likely first. Electron names the profile
 * `<appData>/<app name>`, where appData is ~/Library/Application Support on macOS, %APPDATA% on Windows and
 * $XDG_CONFIG_HOME (or ~/.config) on Linux, and the app name is the bundle name on macOS (the product name:
 * "DEX BOT") but package.json's `name` on Windows and Linux ("dexbot"). Both spellings are searched, so either
 * platform's install keeps its cookies and sign-ins.
 */
export function legacyUserDataDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [join(support, "DEX BOT"), join(support, "dexbot")];
  }
  if (platform === "win32") {
    const roaming = env.APPDATA || join(home, "AppData", "Roaming");
    return [join(roaming, "dexbot"), join(roaming, "DEX BOT")];
  }
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(config, "dexbot"), join(config, "DEX BOT")];
}

/** True for a folder that exists and holds nothing: a fresh profile the app (or Electron) made before this ran. */
function isEmptyDirectory(dir, files) {
  try {
    if (!files.statSync(dir).isDirectory()) return false;
    return files.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Moves `from` to `to` when `to` is missing (or an empty folder), and says whether it did. */
export function moveIntoPlace(from, to, { files = fs, log = () => {} } = {}) {
  if (!from || from === to) return false;
  if (!files.existsSync(from)) return false;
  if (files.existsSync(to)) {
    if (!isEmptyDirectory(to, files)) return false;
    try {
      files.rmSync(to, { recursive: true, force: true });
    } catch (error) {
      log(`could not clear the empty ${to}: ${error?.message ?? error}`);
      return false;
    }
  }
  try {
    files.renameSync(from, to);
  } catch (error) {
    // Another process moved it first, or it is on another volume: use whichever folder is there.
    log(`could not move ${from} to ${to}: ${error?.message ?? error}`);
    return false;
  }
  log(`moved ${from} to ${to}`);
  return true;
}

/**
 * The window's profile folder. Electron names it after the product, so the old build's folder is still
 * there on an existing install: moved into the new name once, before anything reads or writes it.
 * @param {{ currentDir: string, candidates?: string[], files?: typeof fs, log?(line: string): void }} options
 */
export function migrateUserData({ currentDir, candidates = legacyUserDataDirs(), files = fs, log = () => {} }) {
  const from = candidates.find((dir) => files.existsSync(dir));
  if (!from) return { migrated: false, from: null, to: currentDir };
  if (files.existsSync(currentDir) && !isEmptyDirectory(currentDir, files)) {
    return { migrated: false, from, to: currentDir };
  }
  return { migrated: moveIntoPlace(from, currentDir, { files, log }), from, to: currentDir };
}

/**
 * This computer's bot data folder: `~/.lunabot`, with a `~/.dexbot` from an earlier release moved to it.
 * Answers the folder to use, whether or not the move happened.
 * @param {{ home?: string, files?: typeof fs, log?(line: string): void }} options
 */
export function migrateDataDir({ home = os.homedir(), files = fs, log = () => {} } = {}) {
  const current = path.join(home, ".lunabot");
  const legacy = path.join(home, ".dexbot");
  if (files.existsSync(current) || !files.existsSync(legacy)) return current;
  return moveIntoPlace(legacy, current, { files, log }) ? current : legacy;
}

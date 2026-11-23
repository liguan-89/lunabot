import { existsSync, mkdtempSync, renameSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

let home: string | undefined;

/** The home the data folder lives under. Under vitest, with HOME still the real one, a temp folder instead, so a test
 * never reads, migrates or deletes the person's own data. */
export function dataHome(): string {
  if (home !== undefined) return home;
  const real = homedir();
  home = process.env.VITEST !== undefined && real === userInfo().homedir ? mkdtempSync(join(tmpdir(), "lunabot-test-home-")) : real;
  return home;
}

/** The data folder's name under the home: `~/.lunabot`. */
export const DATA_DIR_NAME = ".lunabot";
/** The names earlier releases used, newest first. A person who updates keeps their bots and chats, so each is moved, once, in place. */
export const LEGACY_DATA_DIR_NAMES = [".openmausbot", ".dexbot"] as const;

export interface DataDirDefaults {
  /** The home it sits under; the server's own by default. */
  home?: string;
  /** `posix.join` on a Cloud volume, whose home is always a Linux path. */
  join?: (home: string, name: string) => string;
}

/** Where the server keeps its data: `LUNABOT_DATA_DIR` when set (never migrated, never moved), else `~/.lunabot`, with a
 * folder left under an earlier name by a previous release renamed to it the first time anything asks. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, defaults: DataDirDefaults = {}): string {
  const configured = env.LUNABOT_DATA_DIR?.trim();
  if (configured) return configured;
  const joinPath = defaults.join ?? join;
  const home = defaults.home ?? dataHome();
  const current = joinPath(home, DATA_DIR_NAME);
  if (existsSync(current)) return current;
  const legacy = LEGACY_DATA_DIR_NAMES.map((name) => joinPath(home, name)).find((path) => existsSync(path));
  if (!legacy) return current;
  try {
    renameSync(legacy, current);
  } catch {
    // Another process moved it first, or the folder is busy: use whichever name is there rather than start empty.
    return existsSync(current) ? current : legacy;
  }
  return current;
}

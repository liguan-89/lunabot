import { existsSync, mkdtempSync, renameSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

let home: string | undefined;

/** The home the data folder lives under. Under vitest, with HOME still the real one, a temp folder instead, so a test
 * never reads, migrates or deletes the person's own data. */
export function dataHome(): string {
  if (home !== undefined) return home;
  const real = homedir();
  home = process.env.VITEST !== undefined && real === userInfo().homedir ? mkdtempSync(join(tmpdir(), "omb-test-home-")) : real;
  return home;
}

/** The data folder's name under the home: `~/.lunabot`. */
export const DATA_DIR_NAME = ".lunabot";
/** The name it had before the rename. A person who updates keeps their bots and chats, so it is moved, once, in place. */
export const LEGACY_DATA_DIR_NAME = ".dexbot";

export interface DataDirDefaults {
  /** The home it sits under; the server's own by default. */
  home?: string;
  /** `posix.join` on a Cloud volume, whose home is always a Linux path. */
  join?: (home: string, name: string) => string;
}

/** Where the server keeps its data: `OMB_DATA_DIR` when set (never migrated, never moved), else `~/.lunabot`, with a
 * `~/.dexbot` left by an earlier release renamed to it the first time anything asks. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, defaults: DataDirDefaults = {}): string {
  const configured = env.OMB_DATA_DIR?.trim();
  if (configured) return configured;
  const joinPath = defaults.join ?? join;
  const home = defaults.home ?? dataHome();
  const current = joinPath(home, DATA_DIR_NAME);
  const legacy = joinPath(home, LEGACY_DATA_DIR_NAME);
  if (existsSync(current) || !existsSync(legacy)) return current;
  try {
    renameSync(legacy, current);
  } catch {
    // Another process moved it first, or the folder is busy: use whichever name is there rather than start empty.
    return existsSync(current) ? current : legacy;
  }
  return current;
}

// Copies use `docker cp` over the same SSH transport as every other VPS desktop operation. Local placement is resolved
// before and after directory creation, so a link in the working folder cannot make a download land outside it.
import { randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { cloudCopyArgs, runCommand } from "./cloud-desktop.ts";
import type { AppConfig } from "./config.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "./secret-folder.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";
import { defaultRunner, type VpsCommandRunner } from "./vps-computer.ts";

const MiB = 1024 * 1024;
const COPY_MAX_BYTES = 2 * 1024 * MiB;
/** Left free on the folder's disk, so a download never fills it. */
const DISK_RESERVE_BYTES = 256 * MiB;
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export type CopyOutcome = { path: string; bytes: number } | { error: string };
export interface CopyOptions {
  /** Bytes free on the disk that holds `dir`. */
  freeBytes?(dir: string): number;
  runner?: VpsCommandRunner;
}

const sized = (bytes: number) => bytes >= 1024 * MiB ? `${(bytes / 1024 / MiB).toFixed(1)} GiB` : `${(bytes / MiB).toFixed(1)} MiB`;
const diskFree = (dir: string) => { const disk = statfsSync(dir); return Number(disk.bavail) * Number(disk.bsize); };
const tooBig = (path: string, bytes: number, atLeast = false) =>
  `${path} is ${atLeast ? "over " : ""}${sized(bytes)}; a copy moves at most 2 GiB. Make it smaller on the cloud computer first (filter, compress or split it), then copy the parts.`;
const noSpace = (path: string, bytes: number, free: number, atLeast = false) =>
  `Not enough space for ${path}: it needs ${atLeast ? "more than " : ""}${sized(bytes)} with ${sized(DISK_RESERVE_BYTES)} kept free, and the working folder's disk has ${sized(free)} free.`;

type Placed = { root: string; file: string } | { error: string };

function placeInFolder(folder: string, wanted: string): Placed {
  if (isAbsolute(wanted) || win32.isAbsolute(wanted) || wanted.split(/[\\/]/).includes("..")) {
    return { error: `${wanted} must be a path relative to your working folder, without "..".` };
  }
  let root: string;
  try { root = realpathSync(folder); } catch { return { error: "Your working folder is not available right now." }; }
  const file = resolveThroughLinks(join(root, wanted));
  if (file === root) return { error: "Name a file inside your working folder, not the folder itself." };
  if (!isInside(file, root)) return { error: `${wanted} leads outside your working folder.` };
  if (inSecretFolder(file)) return { error: SECRET_FILE_REFUSAL };
  return { root, file };
}

/** Checked again once the download has begun: a link made in the folder meanwhile would lead the file out. */
function land(placed: { root: string; file: string }, wanted: string): { parent: string; target: string } | { error: string } {
  let parent: string;
  try {
    mkdirSync(dirname(placed.file), { recursive: true });
    parent = realpathSync(dirname(placed.file));
  } catch {
    return { error: `${wanted} cannot be made in your working folder.` };
  }
  if (!isInside(parent, placed.root)) return { error: `${wanted} leads outside your working folder.` };
  const target = join(parent, basename(placed.file));
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return { error: `${wanted} is a folder in your working folder; name a file instead.` };
  return { parent, target };
}

function remoteFilePath(input: string): string | { error: string } {
  if (!input || input.length > 4096 || input.includes("\0") || input.includes(":")) {
    return { error: "The cloud computer path must be a plain Linux path under /home/cua or /tmp." };
  }
  const resolved = posix.normalize(input.startsWith("/") ? input : posix.join("/home/cua", input));
  if ((resolved !== "/tmp" && !resolved.startsWith("/tmp/")) && (resolved !== "/home/cua" && !resolved.startsWith("/home/cua/"))) {
    return { error: "The cloud computer path must stay under /home/cua or /tmp." };
  }
  if (resolved === "/tmp" || resolved === "/home/cua" || resolved.endsWith("/")) return { error: "Name a file on the cloud computer, not a folder." };
  return resolved;
}

async function copyWithDocker(cfg: AppConfig, computer: string, source: string, destination: string, signal: AbortSignal, runner: VpsCommandRunner) {
  await runner(cloudCopyArgs(cfg, computer, source, destination), { timeoutMs: 9 * 60_000, signal });
}

/** Copies to a temporary name beside its place and renames it there, so a failed copy never leaves half a file. */
export async function copyFromComputer(
  cfg: AppConfig,
  computer: string,
  folder: string,
  args: { path: string; to?: string },
  signal: AbortSignal,
  options: CopyOptions = {},
): Promise<CopyOutcome> {
  const runner = options.runner ?? defaultRunner;
  const remote = remoteFilePath(args.path);
  if (typeof remote !== "string") return remote;
  const wanted = args.to ?? posix.basename(remote);
  if (!wanted) return { error: "Name the file to copy, or say where it goes with to." };
  const placed = placeInFolder(folder, wanted);
  if ("error" in placed) return placed;
  const sizeAnswer = await runCommand(cfg, computer, `stat -c %s ${shellQuote(remote)} 2>/dev/null`, { timeoutMs: 15_000, signal });
  if (!sizeAnswer.ok) return { error: `${args.path} is not on the cloud computer.` };
  const bytes = Number(sizeAnswer.stdout.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { error: "The cloud computer gave an unreadable file size. Try again." };
  if (bytes > COPY_MAX_BYTES) return { error: tooBig(args.path, bytes) };
  const free = (options.freeBytes ?? diskFree)(placed.root);
  if (bytes + DISK_RESERVE_BYTES > free) return { error: noSpace(args.path, bytes, free) };
  const landed = land(placed, wanted);
  if ("error" in landed) return landed;
  const { parent, target } = landed;
  const temporary = join(parent, `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);
  let written = false;
  try {
    await copyWithDocker(cfg, computer, `${computer}:${remote}`, temporary, signal, runner);
    signal.throwIfAborted();
    const copied = lstatSync(temporary, { throwIfNoEntry: false });
    if (!copied?.isFile()) return { error: "The cloud computer did not copy a regular file. Try again." };
    renameSync(temporary, target);
    written = true;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { error: "The download from the cloud computer was interrupted; nothing was saved. Try again." };
  } finally {
    if (!written) rmSync(temporary, { force: true });
  }
  return { path: relative(placed.root, target), bytes };
}

/** Copies to a temporary remote file first; the computer keeps its old file unless the whole upload lands. */
export async function copyToComputer(
  cfg: AppConfig,
  computer: string,
  folder: string,
  args: { from: string; path: string },
  signal: AbortSignal,
  options: CopyOptions = {},
): Promise<CopyOutcome> {
  const runner = options.runner ?? defaultRunner;
  const remote = remoteFilePath(args.path);
  if (typeof remote !== "string") return remote;
  const placed = placeInFolder(folder, args.from);
  if ("error" in placed) return placed;
  let handle;
  try {
    handle = await open(placed.file, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: `${args.from} is not in your working folder.` };
    if (code === "ELOOP") return { error: `${args.from} leads outside your working folder.` };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: `${args.from} is not a file.` };
    if (info.size > COPY_MAX_BYTES) return { error: tooBig(args.from, info.size) };
    const temporary = `/tmp/lunabot-upload-${randomBytes(8).toString("hex")}`;
    let uploaded = false;
    try {
      await runCommand(cfg, computer, `mkdir -p ${shellQuote(posix.dirname(remote))}`, { timeoutMs: 15_000, signal });
      await copyWithDocker(cfg, computer, placed.file, `${computer}:${temporary}`, signal, runner);
      uploaded = true;
      const moved = await runCommand(cfg, computer, `mv ${shellQuote(temporary)} ${shellQuote(remote)}`, { timeoutMs: 15_000, signal });
      if (!moved.ok) return { error: "The cloud computer refused the uploaded file. Try again." };
      return { path: remote, bytes: info.size };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { error: `The upload of ${args.from} was interrupted; the cloud computer still has its old file, if any. Try again.` };
    } finally {
      if (uploaded) await runCommand(cfg, computer, `rm -f ${shellQuote(temporary)}`, { timeoutMs: 10_000 }).catch(() => {});
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// Background commands live inside the VPS desktop container: a small per-process directory holds its wrapper, pid,
// exit code and output tails. The process_id carries a hash of the container so one computer cannot name another's process.
import { createHash, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedRemoteCommand, runCommand } from "./cloud-desktop.ts";
import type { CloudComputerResult } from "./cloud-computer-tools.ts";
import type { AppConfig } from "./config.ts";

const PROCESS_ID = /^bg-([1-9][0-9]{0,15})-([0-9a-f]{8})$/;
export const PROCESS_ID_PATTERN = PROCESS_ID.source;
export const STATUS_WAIT_MAX_SECONDS = 60;
export const STDOUT_TAIL_CHARS = 4_000;
export const STDERR_TAIL_CHARS = 2_000;
const POLL_MS = 1_000;
/** Bounds what a forgotten background server can cost in memory and CPU on the VPS. */
export const BACKGROUND_KEEPS_AWAKE_MS = 2 * 60 * 60_000;
const MAX_TRACKED_PER_COMPUTER = 20;
const TAIL_BYTES = 16_384;

const CHECK_BEFORE_RERUN = "Check before starting it again, for example with exec `pgrep -af '<part of the command>'` or by looking at the files it writes";
export const EXEC_LATE = "The command did not finish within this call's time limit. It may still be running on the cloud computer, so do not run it "
  + `again blindly: a second copy can collide with the first, for example by reading its half-written files. ${CHECK_BEFORE_RERUN}. `
  + "Start a command that may run long (downloads, installs, builds, data jobs) with background: true, then follow it with exec_status.";
const START_LATE = `The cloud computer did not confirm the start in time. The command may have started. ${CHECK_BEFORE_RERUN}.`;
const STATUS_LATE = "The cloud computer did not answer in time. Nothing was changed; call exec_status again.";
const OTHER_COMPUTER = "That process_id is not from this cloud computer. Use the process_id that exec with background: true returned on this computer.";
const UNKNOWN_PROCESS = "This cloud computer has no background command with that process_id; it may have restarted since. "
  + "Look at the files the command writes to see how far it got.";
const LOST = "The cloud computer restarted or lost track of this command, so its exit code may be unknown. Look at the files it writes to see how far it got.";
const CUT = "Only the end of the output is shown. Write long output to a file and read the part you need with exec.";

type StatusClock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  timeout: (ms: number) => AbortSignal;
};
const statusClock: StatusClock = {
  now: Date.now,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  timeout: ms => AbortSignal.timeout(ms),
};

const text = (value: string, isError = false): CloudComputerResult => ({ ...(isError ? { isError } : {}), content: [{ type: "text", text: value }] });
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const computerTag = (computer: string) => createHash("sha256").update(computer).digest("hex").slice(0, 8);
export const processIdOn = (computer: string, processId: number) => `bg-${processId}-${computerTag(computer)}`;

function processIdFrom(computer: string, value: string): number | null {
  const match = PROCESS_ID.exec(value);
  const processId = Number(match?.[1]);
  return match && match[2] === computerTag(computer) && Number.isSafeInteger(processId) ? processId : null;
}

function tail(value: string, chars: number): { text: string; cut: boolean } {
  if (value.length <= chars) return { text: value, cut: false };
  const kept = value.slice(-chars);
  const first = kept.charCodeAt(0);
  return { text: first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept, cut: true };
}

/** Process ids started on each computer, with when they started: idle shutdown waits for them. */
const started = new Map<string, Map<number, number>>();

function track(computer: string, processId: number): void {
  const mine = started.get(computer) ?? new Map<number, number>();
  mine.set(processId, Date.now());
  while (mine.size > MAX_TRACKED_PER_COMPUTER) mine.delete(mine.keys().next().value!);
  started.set(computer, mine);
}

function untrack(computer: string, processId: number): void {
  const mine = started.get(computer);
  mine?.delete(processId);
  if (mine?.size === 0) started.delete(computer);
}

const processDir = (processId: number) => `/tmp/lunabot-bg-${processId}`;

function wrapperScript(command: string, dir: string): string {
  const isolated = isolatedRemoteCommand(command).replace(/^exec /, "");
  return `#!/bin/bash
${isolated} >>${shellQuote(`${dir}/stdout.log`)} 2>>${shellQuote(`${dir}/stderr.log`)}
printf '%s' "$?" > ${shellQuote(`${dir}/exit`)}
`;
}

export async function startInBackground(cfg: AppConfig, computer: string, command: string, signal: AbortSignal): Promise<CloudComputerResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const processId = randomInt(1, 1_000_000_000);
    const dir = processDir(processId);
    const encoded = Buffer.from(wrapperScript(command, dir), "utf8").toString("base64");
    const start = [
      `dir=${shellQuote(dir)}`,
      'mkdir "$dir" 2>/dev/null || exit 75',
      `printf %s ${shellQuote(encoded)} | base64 -d > "$dir/run.sh"`,
      'chmod 700 "$dir/run.sh"',
      'nohup "$dir/run.sh" >/dev/null 2>&1 </dev/null &',
      'pid=$!',
      'printf %s "$pid" > "$dir/pid"',
      'echo started',
    ].join("; ");
    const result = await runCommand(cfg, computer, start, { timeoutMs: 15_000, signal });
    if (result.timedOut) return text(START_LATE, true);
    if (result.exitCode === 75) continue;
    if (!result.ok || !/started/.test(result.stdout)) {
      return text(`The cloud computer refused to start the command${result.stderr ? `: ${result.stderr.slice(0, 300)}` : ""}`, true);
    }
    track(computer, processId);
    return text(JSON.stringify({
      processId: processIdOn(computer, processId),
      status: "running",
      next: "It keeps running after this call, but its completion will not automatically resume this turn or notify a delegator. If its result is needed for this task, use exec_status with wait_seconds in this turn until it finishes, then check its exit code and output. If you cannot finish checking in this turn, report it as unfinished with the process_id; do not start another copy blindly.",
    }));
  }
  return text(`The cloud computer could not allocate a background command id. ${CHECK_BEFORE_RERUN}.`, true);
}

interface RemoteStatus {
  state: "running" | "finished" | "lost" | "missing";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function decodeTail(value: string): { text: string; truncated: boolean } {
  if (!value) return { text: "", truncated: false };
  const bytes = Buffer.from(value, "base64");
  return { text: bytes.toString("utf8"), truncated: bytes.length >= TAIL_BYTES };
}

async function readStatus(cfg: AppConfig, computer: string, processId: number, signal: AbortSignal): Promise<RemoteStatus> {
  const dir = processDir(processId);
  const script = [
    `dir=${shellQuote(dir)}`,
    '[ -d "$dir" ] || exit 44',
    'pid=$(cat "$dir/pid" 2>/dev/null || true)',
    'if [ -f "$dir/exit" ]; then state=finished; code=$(cat "$dir/exit" 2>/dev/null);',
    'elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then state=running; code=;',
    'else state=lost; code=; fi',
    'printf \'state=%s\\nexit_code=%s\\n\' "$state" "$code"',
    `printf 'stdout_b64='; tail -c ${TAIL_BYTES} "$dir/stdout.log" 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'`,
    `printf 'stderr_b64='; tail -c ${TAIL_BYTES} "$dir/stderr.log" 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'`,
  ].join("; ");
  const out = await runCommand(cfg, computer, script, { timeoutMs: 15_000, signal });
  if (out.exitCode === 44) return { state: "missing", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  if (!out.ok) throw new Error(out.stderr.trim() || "the cloud computer could not read the command status");
  const fields = new Map(out.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)] as const;
  }));
  const state = fields.get("state");
  const stdout = decodeTail(fields.get("stdout_b64") ?? "");
  const stderr = decodeTail(fields.get("stderr_b64") ?? "");
  const exitCode = Number(fields.get("exit_code") ?? "");
  return {
    state: state === "running" || state === "finished" || state === "lost" ? state : "missing",
    exitCode: state === "finished" && Number.isInteger(exitCode) ? exitCode : null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function describeStatus(processId: string, status: RemoteStatus): CloudComputerResult {
  const stdout = tail(status.stdout, STDOUT_TAIL_CHARS), stderr = tail(status.stderr, STDERR_TAIL_CHARS);
  return text(JSON.stringify({
    processId,
    status: status.state,
    exitCode: status.state === "finished" ? status.exitCode : null,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(stdout.cut || stderr.cut || status.stdoutTruncated || status.stderrTruncated ? { outputCut: CUT } : {}),
    ...(status.state === "lost" ? { note: LOST } : {}),
  }));
}

export async function backgroundStatus(
  cfg: AppConfig,
  computer: string,
  args: { process_id: string; wait_seconds?: number },
  signal: AbortSignal,
  clock: StatusClock = statusClock,
): Promise<CloudComputerResult> {
  const processId = processIdFrom(computer, args.process_id);
  if (processId === null) return text(OTHER_COMPUTER, true);
  const waitMs = Math.min(args.wait_seconds ?? 0, STATUS_WAIT_MAX_SECONDS) * 1_000;
  const until = clock.now() + waitMs;
  for (;;) {
    signal.throwIfAborted();
    const status = await readStatus(cfg, computer, processId, signal);
    if (status.state === "missing") return text(UNKNOWN_PROCESS, true);
    if (status.state !== "running") {
      untrack(computer, processId);
      return describeStatus(args.process_id, status);
    }
    if (clock.now() >= until) return describeStatus(args.process_id, status);
    await clock.sleep(Math.min(POLL_MS, Math.max(1, until - clock.now())), signal);
  }
}

/** True while a still-young background command started here may keep the desktop busy. */
export async function backgroundCommandRunning(cfg: AppConfig, computer: string): Promise<boolean> {
  const mine = started.get(computer);
  if (!mine) return false;
  for (const [processId, startedAt] of mine) {
    if (Date.now() - startedAt > BACKGROUND_KEEPS_AWAKE_MS) {
      mine.delete(processId);
      continue;
    }
    try {
      const status = await readStatus(cfg, computer, processId, AbortSignal.timeout(10_000));
      if (status.state === "running") return true;
      untrack(computer, processId);
    } catch {
      return true;
    }
  }
  if (mine.size === 0) started.delete(computer);
  return false;
}

export function commandLateText(name: unknown, args: unknown): string | undefined {
  if (name === "exec_status") return STATUS_LATE;
  if (name !== "exec") return undefined;
  return (args as { background?: unknown }).background === true ? START_LATE : EXEC_LATE;
}

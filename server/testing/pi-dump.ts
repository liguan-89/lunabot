// The fake pi's launch log. The pi driver keeps one process per thread and hands it the MCP config at boot, so the
// fake appends a line when it launches (argv and that config) and one per prompt it is given. A recipe reads the log
// where it used to read the Claude fixture's per-turn dump: the prompt says what the turn was told, the launch that
// precedes it says which servers and approval level the turn ran with.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VOLATILE_CONTEXT_CLEARED_NOTE, VOLATILE_CONTEXT_NOTE_PREFIX } from "../drivers/prompt-split.ts";
import { TURN_CLOCK_LEAD } from "../turn-clock.ts";

export interface PiMcpConfig {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  approvalMode?: string | null;
  toolScope?: unknown;
}

export interface PiLaunch {
  /** The fake process's pid: a warm child keeps its pid across the turns it runs. */
  pid?: number;
  argv: string[];
  /** The working folder the child was spawned in. */
  cwd?: string;
  envConfigured: string[];
  mcpConfig: PiMcpConfig | null;
}

export interface PiTurn {
  /** The launch the turn ran on; null before the first launch line. */
  launch: PiLaunch | null;
  /** The pid of the process that was given the prompt: a warm child's later turns can be re-paired with their launch
   * after the log was truncated between turns, when no launch line survives in what remains. */
  pid?: number;
  /** The message the turn was given: system prompt, time line and the person's words together. */
  prompt: string;
  images?: unknown[];
}

/** The fixture's launch log for a data dir, as `launchVerificationServer` points FAKE_PI_DUMP at. */
export const piDumpPath = (dataDir: string) => join(dataDir, "fake-pi-dump.jsonl");

/** Every turn the fixture's pi processes were given, in order, each with the launch it ran on. A prompt row carries
 * its process's pid, so a turn is paired with its own launch even when another process's launch line lands between
 * them (a warm child's second turn, or two servers writing one log); a row without a pid keeps the line it follows. */
export function piTurns(path: string): PiTurn[] {
  if (!existsSync(path)) return [];
  const turns: PiTurn[] = [];
  let launch: PiLaunch | null = null;
  const byPid = new Map<number, PiLaunch>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.argv) {
      launch = { ...(typeof row.pid === "number" ? { pid: row.pid } : {}), argv: row.argv, ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}), envConfigured: row.envConfigured ?? [], mcpConfig: row.mcpConfig ?? null };
      if (typeof launch.pid === "number") byPid.set(launch.pid, launch);
      continue;
    }
    const message = row.prompt?.message;
    if (typeof message === "string") {
      const own = typeof row.pid === "number" ? byPid.get(row.pid) ?? launch : launch;
      turns.push({ launch: own, ...(typeof row.pid === "number" ? { pid: row.pid } : {}), prompt: message, ...(Array.isArray(row.prompt.images) ? { images: row.prompt.images } : {}) });
    }
  }
  return turns;
}

/** The most recent turn whose prompt holds `text`, for a recipe that waits for a turn to be under way. */
export const piTurnHolding = (path: string, text: string): PiTurn | undefined =>
  piTurns(path).filter((turn) => turn.prompt.includes(text)).at(-1);

/** The model each turn asked pi to switch to, in order. */
export function piModelsSet(path: string): Array<{ provider: string; modelId: string }> {
  if (!existsSync(path)) return [];
  const applied: Array<{ provider: string; modelId: string }> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { setModel?: { provider?: unknown; modelId?: unknown } };
      if (typeof row.setModel?.provider === "string" && typeof row.setModel.modelId === "string") {
        applied.push({ provider: row.setModel.provider, modelId: row.setModel.modelId });
      }
    } catch {}
  }
  return applied;
}

/** The turns the fixture ran on one conversation, whichever bot's shell they launched. */
export function piTurnsForThread(path: string, threadId: string): PiTurn[] {
  return piTurns(path).filter((turn) => turn.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_THREAD_ID === threadId);
}

/** The agents server's token the turn's MCP config carries, for a recipe that calls the harness's internal routes. */
export const piAgentsToken = (turn: PiTurn | undefined): string | undefined =>
  turn?.launch?.mcpConfig?.mcpServers?.agents?.env?.LUNABOT_COMMS_TOKEN;

/** A turn's own words: the time line and what the person wrote, without the instructions above them. */
export function piTurnText(turn: PiTurn): string {
  const at = turn.prompt.indexOf(TURN_CLOCK_LEAD);
  return at >= 0 ? turn.prompt.slice(at) : turn.prompt;
}

/** The instructions actually in effect on that turn: pi sends the whole system prompt on a session's first turn (and
 * whenever its stable half changes), and only the note that replaced part of it afterwards. */
export function piInstructionsAt(turns: PiTurn[], index: number): string {
  let full = "";
  for (let i = 0; i <= index && i < turns.length; i++) {
    const at = turns[i]!.prompt.indexOf(TURN_CLOCK_LEAD);
    const prefix = at >= 0 ? turns[i]!.prompt.slice(0, at).trimEnd() : "";
    if (!prefix) continue;
    full = prefix.startsWith(VOLATILE_CONTEXT_NOTE_PREFIX) || prefix.startsWith(VOLATILE_CONTEXT_CLEARED_NOTE)
      ? `${full}\n${prefix}`
      : prefix;
  }
  return full;
}

/** The index of the last turn whose own words hold `text`. */
export function piTurnIndex(turns: PiTurn[], text: string): number {
  for (let i = turns.length - 1; i >= 0; i--) if (piTurnText(turns[i]!).includes(text)) return i;
  return -1;
}

/** The instructions in effect on one turn. A slash command carries no time line, and the request the server makes of it
 * is the message's last paragraph, so the blank line above that paragraph is where the instructions end. */
export function piInstructionsFor(turns: PiTurn[], index: number): string {
  const turn = turns[index];
  if (!turn) return "";
  if (turn.prompt.includes(TURN_CLOCK_LEAD)) return piInstructionsAt(turns, index);
  const at = turn.prompt.lastIndexOf("\n\n");
  return at > 0 ? turn.prompt.slice(0, at).trimEnd() : "";
}
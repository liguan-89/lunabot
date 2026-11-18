import type { InstanceConfigMap } from "./contracts.ts";
import { serverLine } from "./server-lines.ts";

export const REMOVED_COMPUTER_DRIVER = "boxAgent";
const REMOVED_COMPUTER_INSTANCE = "computer";

/** An id the person reused for another engine is theirs and stays. */
export function removedComputerInstanceIds(saved: InstanceConfigMap | undefined): Set<string> {
  const ids = new Set<string>();
  const reused = saved && Object.hasOwn(saved, REMOVED_COMPUTER_INSTANCE) &&
    saved[REMOVED_COMPUTER_INSTANCE]!.driver !== REMOVED_COMPUTER_DRIVER;
  if (!reused) ids.add(REMOVED_COMPUTER_INSTANCE);
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (entry.driver === REMOVED_COMPUTER_DRIVER) ids.add(id);
  }
  return ids;
}

export interface ComputerEngineMove {
  botId: string;
  threadId: string;
  /** "bot": the bot's engine moved; "conversation": only this conversation's did; "bot-only": the bot's did, but this conversation keeps its own. */
  scope: "bot" | "conversation" | "bot-only";
  cloud: boolean;
  /** It worked on the cloud computer and the new engine can't: "auto" now works without one; "works-on" or "pin" still say Cloud, so turns are refused. */
  noComputer: false | "auto" | "works-on" | "pin";
  /** Permissions went back to Ask, as on any engine switch. */
  askNow: boolean;
}

export function computerEngineMoveText(
  move: Pick<ComputerEngineMove, "scope" | "cloud" | "askNow"> & Partial<Pick<ComputerEngineMove, "noComputer">>,
  botName: string,
  engine: string,
  language?: string,
): string {
  const bot = move.scope !== "conversation";
  const head = move.scope === "conversation" ? serverLine(language, "server.engine.head.conversation", { engine })
    : move.scope === "bot-only" ? serverLine(language, "server.engine.head.bot-only", { bot: botName, engine })
    : serverLine(language, "server.engine.head.bot", { bot: botName, engine });
  const place = move.cloud
    ? bot
      ? serverLine(language, "server.engine.cloud.bot", { bot: botName })
      : serverLine(language, "server.engine.cloud.other", { bot: botName })
    : move.noComputer === "auto"
      ? bot
        ? serverLine(language, "server.engine.auto.bot", { bot: botName, engine })
        : serverLine(language, "server.engine.auto.other", { bot: botName, engine })
    : move.noComputer === "works-on"
      ? serverLine(language, "server.engine.worksOn", { bot: botName, engine })
    : move.noComputer === "pin"
      ? serverLine(language, "server.engine.pin", { bot: botName, engine })
    : "";
  const ask = !move.askNow ? ""
    : move.scope === "bot-only" ? serverLine(language, "server.engine.ask.bot-only", { bot: botName })
    : serverLine(language, "server.engine.ask.other");
  return `${head} ${serverLine(language, "server.engine.removed")}${place}${ask}`;
}

/** The move is saved already, so a failing line is logged and every other line is still written. */
export function writeComputerEngineMoveLines(moves: readonly ComputerEngineMove[], write: (move: ComputerEngineMove) => void): void {
  for (const move of moves) {
    try {
      write(move);
    } catch (error) {
      console.warn(`[engines] the Computer engine move line for ${move.threadId} was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

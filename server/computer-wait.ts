import { serverLine } from "./server-lines.ts";

export interface ComputerHolder {
  name: string;
  task?: string;
}

const english = (language?: string): boolean => /^en(?:-|$)/i.test(language ?? "en");

const durationText = (ms: number, language?: string): string => {
  if (ms < 1_000) return serverLine(language, "server.wait.underSecond");
  const value = ms >= 60_000 ? Math.round(ms / 60_000) : Math.round(ms / 1000);
  const minutes = ms >= 60_000;
  const unit = minutes
    ? serverLine(language, value === 1 ? "server.wait.minuteOne" : "server.wait.minutes", { count: value })
    : serverLine(language, value === 1 ? "server.wait.secondOne" : "server.wait.seconds", { count: value });
  return unit;
};

export function computerWaitDuration(ms: number, language?: string): string {
  return ms < 1_000 ? serverLine(language, "server.wait.underSecond") : durationText(ms, language);
}

const holderPhrase = (holder: ComputerHolder, language?: string): string =>
  holder.task
    ? serverLine(language, "server.wait.running", { name: holder.name, task: holder.task })
    : serverLine(language, "server.wait.using", { name: holder.name });

const stillHolderPhrase = (holder: ComputerHolder, language?: string): string =>
  holder.task
    ? serverLine(language, "server.wait.stillRunning", { name: holder.name, task: holder.task })
    : serverLine(language, "server.wait.stillUsing", { name: holder.name });

export interface WaitQueueFact {
  position?: number;
  estimateMs?: number;
}

const ordinal = (position: number): string => {
  const mod100 = position % 100;
  const mod10 = position % 10;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
  return `${position}${suffix}`;
};

const queuePositionText = (position: number, language?: string): string =>
  english(language) ? ordinal(position) : serverLine(language, "server.wait.queueOrdinal", { position });

export function computerWaitingText(holder?: ComputerHolder | null, queue?: WaitQueueFact, language?: string): string {
  const position = queue?.position && queue.position > 0 ? queue.position : undefined;
  const place = position ? serverLine(language, "server.wait.queuePlace", { position: queuePositionText(position, language) }) : "";
  const estimate = queue?.estimateMs !== undefined
    ? serverLine(language, "server.wait.estimate", { duration: computerWaitDuration(queue.estimateMs, language) })
    : "";
  // Behind more than the holder: the freed seat goes to the front waiter first.
  const starts = position && position > 1
    ? serverLine(language, "server.wait.startsAhead")
    : holder
      ? serverLine(language, "server.wait.startsFinishes")
      : serverLine(language, "server.wait.startsFree");
  if (!holder) return serverLine(language, "server.wait.waiting", { place, starts, estimate });
  return serverLine(language, "server.wait.waitingHolder", { place, holder: holderPhrase(holder, language), starts, estimate });
}

export function computerFreeAfterText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const who = holder
    ? holder.task
      ? serverLine(language, "server.wait.heldItTask", { name: holder.name, task: holder.task })
      : serverLine(language, "server.wait.heldIt", { name: holder.name })
    : "";
  return serverLine(language, "server.wait.freeAfter", { duration: computerWaitDuration(waitedMs, language), who });
}

export function computerStoppedWaitingText(holder: ComputerHolder | null | undefined, waitedMs: number, language?: string): string {
  const who = holder ? serverLine(language, "server.wait.stoppedWho", { holder: holderPhrase(holder, language) }) : "";
  return serverLine(language, "server.wait.stopped", { duration: computerWaitDuration(waitedMs, language), who });
}

export function computerParkedText(holder: ComputerHolder | null | undefined, ceilingMs: number, language?: string): string {
  const duration = durationText(ceilingMs, language);
  return holder
    ? serverLine(language, "server.wait.parkedHolder", { duration, holder: stillHolderPhrase(holder, language) })
    : serverLine(language, "server.wait.parked", { duration });
}

export function computerPersonAwayText(ceilingMs: number, language?: string): string {
  return serverLine(language, "server.wait.personAway", { duration: durationText(ceilingMs, language) });
}

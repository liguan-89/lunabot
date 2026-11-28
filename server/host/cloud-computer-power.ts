// VPS desktops stop when nothing uses them: unlike Boat this saves memory/CPU on the owner's host, not a provider bill.
import { backgroundCommandRunning } from "../cloud-computer-background.ts";
import { cloudTurnLifecycleAction, findCloudComputer, provisionCloudComputer, readyCloudComputer, sleepCloudComputer, type ManagedCloudOwner } from "../cloud-desktop.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import type { AppConfig } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Routine } from "../routines.ts";
import type { BotRecord } from "../store.ts";
import type { TurnOwner } from "../turn-resources.ts";
import { listManagedVpsComputers } from "../vps-computer.ts";

export const CLOUD_COMPUTER_IDLE_MS = Math.max(1_000, Number(process.env.LUNABOT_CLOUD_COMPUTER_IDLE_MS) || 10 * 60_000);
/** A computer stays on while a routine that uses it is due this soon. Longer than the idle window, so a routine every 30
 * minutes or more often never waits on a wake. */
export const ROUTINE_DUE_SOON_MS = 30 * 60_000;
const MAX_LISTING_RETRY_MS = 60 * 60_000;
/** Above a slow first start. */
export const CLOUD_COMPUTER_START_BUDGET_MS = Math.max(1_000, Number(process.env.LUNABOT_CLOUD_COMPUTER_START_BUDGET_MS) || 150_000);
export const CLOUD_COMPUTER_STARTING = "The cloud computer is still starting. This call was not performed. Take a fresh screenshot in a moment.";
export const CLOUD_COMPUTER_DID_NOT_START = "the cloud computer didn't start in time";

type ScheduledRoutine = Pick<Routine, "botId" | "runOn" | "enabled" | "nextRunAt">;

export interface CloudComputerPowerDeps {
  cfg: AppConfig;
  /** Keyed by the computer's owner: a bot id, or a team computer's owner key. True while any turn, routine run, person's
   * control, lifecycle action or provider change still uses it. */
  busy(owner: string): boolean;
  /** Takes the owner's lifecycle lane synchronously, so no turn starts on it until released; throws when it is taken or in use. */
  claim(owner: string): () => void;
  owners(): ManagedCloudOwner[];
  routines(): readonly ScheduledRoutine[];
  /** The owner of the cloud computer this routine's turns use, or null when they use none. */
  routineComputer(routine: ScheduledRoutine): string | null;
  /** Resolves the VPS alias for a bot-owned computer; team computers use cfg. */
  cfgForBot?(bot: BotRecord): AppConfig;
  /** Every alias the installation scans when arming computers left running. */
  vpsAliases?(): string[];
  broadcast(payload: Record<string, unknown>): void;
  log(line: string): void;
}

export function createCloudComputerPower(deps: CloudComputerPowerDeps) {
  const { cfg, broadcast } = deps;
  const timers = new Map<string, ComputerIdleTimer>();
  const turnOwners = new Map<string, { generation: string; owner: string }>();
  const starting = new Map<string, number>();
  let listingRetry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const cfgForOwner = (owner: string) => {
    const bot = deps.owners().find((entry) => entry.botId === owner);
    // Bot ids are stable enough for this lookup only through owners; team owner keys deliberately fall back to cfg.
    const record = bot && !owner.startsWith("computer_") ? { id: owner, vpsAlias: undefined } : null;
    void record;
    return cfg;
  };
  const routineDueSoon = (owner: string) => deps.routines().some(routine => routine.enabled && routine.nextRunAt !== null &&
    routine.nextRunAt - Date.now() <= ROUTINE_DUE_SOON_MS && deps.routineComputer(routine) === owner);
  const busy = (owner: string) => (starting.get(owner) ?? 0) > 0 || deps.busy(owner) || routineDueSoon(owner);

  function forget(owner: string): void {
    timers.get(owner)?.cancel();
    timers.delete(owner);
  }

  async function sleepIfIdle(owner: string): Promise<void | "busy"> {
    const machine = await findCloudComputer(cfgForOwner(owner), owner);
    if (closed) return;
    if (!machine || machine.state !== "running") return forget(owner);
    if (cloudTurnLifecycleAction(machine.state) !== "attach" || busy(owner)) return "busy";
    if (await backgroundCommandRunning(cfgForOwner(owner), machine.id)) return "busy";
    if (closed) return;
    let release: () => void;
    try {
      release = deps.claim(owner);
    } catch {
      return "busy";
    }
    try {
      await sleepCloudComputer(cfgForOwner(owner), owner);
    } finally {
      release();
    }
    forget(owner);
    deps.log(`cloud computer ${owner}: stopped after ${Math.round(CLOUD_COMPUTER_IDLE_MS / 1_000)}s idle`);
  }

  /** Starts, or restarts, this owner's idle window. */
  function used(owner: string): void {
    if (closed) return;
    let timer = timers.get(owner);
    if (!timer) {
      timer = new ComputerIdleTimer(CLOUD_COMPUTER_IDLE_MS, () => busy(owner), () => sleepIfIdle(owner), (error, retryInMs) => {
        const reason = redactSecretsInText(error instanceof Error ? error.message : String(error));
        deps.log(`cloud computer ${owner}: could not stop, retrying in ${Math.ceil(retryInMs / 60_000)} min: ${reason}`);
      });
      timers.set(owner, timer);
    }
    timer.touch();
  }

  function attached(turn: TurnOwner, owner: string): void {
    turnOwners.set(turn.threadId, { generation: turn.generation, owner });
    used(owner);
  }

  function released(turn: TurnOwner): void {
    const held = turnOwners.get(turn.threadId);
    if (held?.generation !== turn.generation) return;
    turnOwners.delete(turn.threadId);
    used(held.owner);
  }

  /** `existingOnly`: wake or attach the bot's computer, but never create one (null when it has none). */
  async function start(bot: BotRecord, turn: TurnOwner, opts: { existingOnly?: boolean; budgetMs?: number } = {}) {
    attached(turn, bot.id);
    starting.set(bot.id, (starting.get(bot.id) ?? 0) + 1);
    const botCfg = deps.cfgForBot?.(bot) ?? cfg;
    try {
      broadcast({ kind: "computer", botId: bot.id, state: "provisioning", place: "cloud" });
      const machine = opts.existingOnly
        ? await readyCloudComputer(botCfg, bot.id, opts.budgetMs ?? CLOUD_COMPUTER_START_BUDGET_MS)
        : (await provisionCloudComputer(botCfg, bot.id, bot.name), await readyCloudComputer(botCfg, bot.id, opts.budgetMs ?? CLOUD_COMPUTER_START_BUDGET_MS));
      return machine;
    } finally {
      const left = (starting.get(bot.id) ?? 1) - 1;
      if (left > 0) starting.set(bot.id, left);
      else starting.delete(bot.id);
    }
  }

  /** At startup: what a previous run left on gets the same window. Orphans stay for Settings → Computers. */
  async function armRunning(retryInMs = CLOUD_COMPUTER_IDLE_MS): Promise<void> {
    if (closed) return;
    const inventory = await listManagedVpsComputers(cfg, deps.owners(), undefined, deps.vpsAliases?.()).catch(() => null);
    if (closed) return;
    if (!inventory?.available) {
      deps.log(`cloud computers: could not list them to time the ones left on, retrying in ${Math.ceil(retryInMs / 60_000)} min: ${inventory?.problem ?? "listing failed"}`);
      listingRetry = setTimeout(() => void armRunning(Math.min(retryInMs * 2, MAX_LISTING_RETRY_MS)), retryInMs);
      listingRetry.unref?.();
      return;
    }
    for (const instance of inventory.instances) {
      if (instance.ownerBotId && instance.state === "running") used(instance.ownerBotId);
    }
  }

  return {
    start,
    attached,
    released,
    used,
    /** A computer is on (its idle window runs here) or starting. */
    awake: () => timers.size > 0 || starting.size > 0,
    renew: (owner: string) => timers.get(owner)?.touch(),
    armRunning,
    close(): void {
      closed = true;
      if (listingRetry) clearTimeout(listingRetry);
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}

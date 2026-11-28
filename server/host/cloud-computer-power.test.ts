import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";

const fake = vi.hoisted(() => ({
  states: new Map<string, string>(),
  findCloudComputer: vi.fn(),
  sleepCloudComputer: vi.fn(),
  readyCloudComputer: vi.fn(),
  provisionCloudComputer: vi.fn(),
  backgroundCommandRunning: vi.fn(),
  listManagedVpsComputers: vi.fn(),
}));

vi.mock("../cloud-desktop.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../cloud-desktop.ts")>(),
  findCloudComputer: fake.findCloudComputer,
  sleepCloudComputer: fake.sleepCloudComputer,
  readyCloudComputer: fake.readyCloudComputer,
  provisionCloudComputer: fake.provisionCloudComputer,
}));
vi.mock("../cloud-computer-background.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../cloud-computer-background.ts")>(),
  backgroundCommandRunning: fake.backgroundCommandRunning,
}));
vi.mock("../vps-computer.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../vps-computer.ts")>(),
  listManagedVpsComputers: fake.listManagedVpsComputers,
}));

const { CLOUD_COMPUTER_IDLE_MS, createCloudComputerPower } = await import("./cloud-computer-power.ts");

const MINUTE = 60_000;
const CFG = { vps: { sshAlias: "production-vps" } } as AppConfig;
const bot = (id: string) => ({ id, name: id }) as BotRecord;
const turn = (threadId: string, generation = "g1") => ({ threadId, generation });

describe("VPS cloud computer power", () => {
  let busy: Set<string>;
  let claims: string[];
  let logs: string[];
  let broadcasts: Record<string, unknown>[];
  let power: ReturnType<typeof createCloudComputerPower>;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.states = new Map();
    fake.findCloudComputer.mockReset().mockImplementation(async (_cfg: unknown, owner: string) =>
      fake.states.has(owner) ? { id: `machine-${owner}`, state: fake.states.get(owner), desktopAvailable: true } : null);
    fake.sleepCloudComputer.mockReset().mockImplementation(async (_cfg: unknown, owner: string) => { fake.states.set(owner, "archived"); });
    fake.readyCloudComputer.mockReset().mockImplementation(async (_cfg: unknown, owner: string) =>
      fake.states.get(owner) === "running" ? { id: `machine-${owner}`, state: "running", desktopAvailable: true } : null);
    fake.provisionCloudComputer.mockReset().mockImplementation(async (_cfg: unknown, owner: string) => { fake.states.set(owner, "running"); });
    fake.backgroundCommandRunning.mockReset().mockResolvedValue(false);
    fake.listManagedVpsComputers.mockReset().mockResolvedValue({ configured: true, available: true, problem: null, instances: [] });
    busy = new Set();
    claims = [];
    logs = [];
    broadcasts = [];
    power = createCloudComputerPower({
      cfg: CFG,
      busy: owner => busy.has(owner),
      claim: owner => { claims.push(`claim ${owner}`); return () => claims.push(`release ${owner}`); },
      owners: () => [],
      routines: () => [],
      routineComputer: () => null,
      broadcast: payload => broadcasts.push(payload),
      log: line => logs.push(line),
    });
  });

  afterEach(() => {
    power.close();
    vi.useRealTimers();
  });

  it("stops a running desktop only after a full idle window, holding its lifecycle lane for the stop", async () => {
    fake.states.set("bot-a", "running");
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS - 1);
    expect(fake.findCloudComputer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sleepCloudComputer).toHaveBeenCalledWith(CFG, "bot-a");
    expect(claims).toEqual(["claim bot-a", "release bot-a"]);
    expect(logs).toEqual([`cloud computer bot-a: stopped after ${Math.round(CLOUD_COMPUTER_IDLE_MS / 1_000)}s idle`]);
  });

  it("does not stop while the owner is busy or a background command still runs", async () => {
    fake.states.set("bot-a", "running");
    busy.add("bot-a");
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS);
    expect(fake.sleepCloudComputer).not.toHaveBeenCalled();

    busy.clear();
    fake.backgroundCommandRunning.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS);
    expect(fake.sleepCloudComputer).not.toHaveBeenCalled();
  });

  it("counts a turn's idle window from its own generation's release, not an older release", async () => {
    fake.states.set("bot-a", "running");
    power.attached(turn("thread-a", "g2"), "bot-a");
    power.released(turn("thread-a", "g1"));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    power.released(turn("thread-a", "g2"));
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS - 1);
    expect(fake.sleepCloudComputer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sleepCloudComputer).toHaveBeenCalledOnce();
  });

  it("start provisions by default, but existingOnly only reuses a running desktop", async () => {
    const owner = turn("thread-a");
    const missing = await power.start(bot("bot-a"), owner, { existingOnly: true });
    expect(missing).toBeNull();
    expect(fake.provisionCloudComputer).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([{ kind: "computer", botId: "bot-a", state: "provisioning", place: "cloud" }]);

    await power.start(bot("bot-a"), owner);
    expect(fake.provisionCloudComputer).toHaveBeenCalledWith(CFG, "bot-a", "bot-a");
    expect(fake.readyCloudComputer).toHaveBeenCalled();
  });

  it("backs off a failed stop instead of retrying in a tight loop", async () => {
    fake.states.set("bot-a", "running");
    fake.sleepCloudComputer.mockRejectedValue(new Error("docker over SSH failed"));
    power.used("bot-a");
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS);
    expect(fake.sleepCloudComputer).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatch(/could not stop, retrying in 10 min: docker over SSH failed/);
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS - 1);
    expect(fake.sleepCloudComputer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sleepCloudComputer).toHaveBeenCalledTimes(2);
  });

  it("arms computers left running by the previous server process", async () => {
    fake.states.set("bot-a", "running");
    fake.listManagedVpsComputers.mockResolvedValue({
      configured: true,
      available: true,
      problem: null,
      instances: [{ name: "one", state: "running", ownerBotId: "bot-a", ownerName: "A", orphaned: false, inUse: false, vpsAlias: "production-vps" }],
    });
    await power.armRunning();
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_IDLE_MS);
    expect(fake.sleepCloudComputer).toHaveBeenCalledWith(CFG, "bot-a");
  });
});

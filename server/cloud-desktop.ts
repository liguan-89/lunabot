// VPS-backed cloud desktop access. The transport is Docker-over-SSH; no cloud-desktop provider credential exists here.
import { defaultRunner, vpsComputerAction, vpsComputerJoin, vpsComputerStatus, vpsContainerName, vpsDockerArgs, listManagedVpsComputers, removeManagedVpsComputer, type ManagedVpsOwner, type VpsCommandRunner, type VpsComputerStatus } from "./vps-computer.ts";
import { vpsSshAlias, type AppConfig } from "./config.ts";

const CONTAINER_ID = /^[0-9a-f]{12,64}$/i;
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const MAX_REMOTE_COMMAND_LENGTH = 4_000;

/** Runs an owner-supplied console command without the host or Docker credentials in its environment. */
export function isolatedRemoteCommand(command: string): string {
  return [
    "exec env -i",
    'HOME="$HOME"',
    'USER="${USER:-$(id -un)}"',
    'LOGNAME="${LOGNAME:-${USER:-$(id -un)}}"',
    'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'DISPLAY="${DISPLAY:-:1}"',
    'XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"',
    'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}"',
    "/bin/bash -c",
    shellQuote(command),
  ].join(" ");
}

function requireAlias(cfg: AppConfig): string {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in Settings → API keys"), { status: 409 });
  return alias;
}

function validComputerRef(computer: string): boolean {
  return CONTAINER_ID.test(computer) || CONTAINER_NAME.test(computer);
}

export function cloudExecArgs(cfg: AppConfig, computer: string, command: string): string[] {
  const alias = requireAlias(cfg);
  if (!validComputerRef(computer)) throw new Error("invalid cloud computer reference");
  return vpsDockerArgs(alias, [
    "exec",
    "--user", "cua",
    "--workdir", "/home/cua",
    "--env", "HOME=/home/cua",
    "--env", "USER=cua",
    "--env", "LOGNAME=cua",
    "--env", "DISPLAY=:1",
    "--env", "XDG_RUNTIME_DIR=/run/user/1000",
    computer,
    "/bin/bash",
    "-lc",
    command,
  ]);
}


export function cloudCopyArgs(cfg: AppConfig, computer: string, source: string, destination: string): string[] {
  const alias = requireAlias(cfg);
  if (!validComputerRef(computer)) throw new Error("invalid cloud computer reference");
  return vpsDockerArgs(alias, ["cp", source, destination]);
}

export async function runCommand(
  cfg: AppConfig,
  computer: string,
  command: string,
  { timeoutMs = 120_000, signal, runner = defaultRunner }: { timeoutMs?: number; signal?: AbortSignal; runner?: VpsCommandRunner } = {},
) {
  try {
    const result = await runner(cloudExecArgs(cfg, computer, command), { timeoutMs, signal, allowFailure: true });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Docker-over-SSH command timed out") {
      return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: true as const };
    }
    throw error;
  }
}

const READY = new Set(["running"]);
export const SLEEPING_CLOUD_STATES = new Set(["archived", "archiving"]);
export type CloudTurnLifecycleAction = "attach" | "provision" | "wake";

export function cloudTurnLifecycleAction(state: string | null): CloudTurnLifecycleAction {
  if (state && READY.has(state)) return "attach";
  return state ? "wake" : "provision";
}

export type ManagedCloudOwner = ManagedVpsOwner;

export interface ManagedCloudInventoryInstance {
  boxId: string;
  name: string;
  state: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
  vpsAlias: string;
}

export interface ManagedCloudInventory {
  configured: boolean;
  available: boolean;
  problem: string | null;
  instances: ManagedCloudInventoryInstance[];
  unreachable?: true;
}

const inventoryState = (state: string) => state === "running" ? "running" : state === "removing" ? "removing" : "archived";

export async function listManagedCloudComputers(
  cfg: AppConfig,
  owners: ManagedCloudOwner[],
  opts: { vpsAliases?: string[] } = {},
): Promise<ManagedCloudInventory> {
  const inventory = await listManagedVpsComputers(cfg, owners, undefined, opts.vpsAliases);
  return {
    configured: inventory.configured,
    available: inventory.available,
    problem: inventory.problem,
    instances: inventory.instances.map((instance) => ({
      boxId: instance.name,
      name: instance.name,
      state: inventoryState(instance.state),
      ownerBotId: instance.ownerBotId,
      ownerName: instance.ownerName,
      orphaned: instance.orphaned,
      inUse: instance.inUse,
      vpsAlias: instance.vpsAlias,
    })),
    ...(inventory.unreachable ? { unreachable: true as const } : {}),
  };
}

export function cloudConfigured(cfg: AppConfig): boolean {
  return vpsSshAlias(cfg) !== null;
}

function machineFromStatus(status: VpsComputerStatus): { id: string; state: string; desktopAvailable: boolean | null } | null {
  if (status.container === "missing") return null;
  return {
    id: status.container_id ?? status.container_name,
    state: status.container === "running" ? "running" : "archived",
    desktopAvailable: status.desktopReady,
  };
}

async function statusOrThrow(cfg: AppConfig, ownerId: string): Promise<VpsComputerStatus> {
  const status = await vpsComputerStatus(cfg, ownerId);
  if (!status.daemonUp) {
    throw Object.assign(new Error(status.problem ?? "Docker over SSH is not reachable"), { status: 503 });
  }
  return status;
}

export async function findCloudComputer(cfg: AppConfig, ownerId: string) {
  return machineFromStatus(await statusOrThrow(cfg, ownerId));
}

export async function cloudStatus(cfg: AppConfig, ownerId: string) {
  if (!cloudConfigured(cfg)) return { configured: false, box: null };
  const machine = await findCloudComputer(cfg, ownerId);
  return {
    configured: true,
    box: machine ? { boxId: machine.id, state: machine.state, desktopAvailable: machine.desktopAvailable } : null,
  };
}

export async function readyCloudComputer(cfg: AppConfig, ownerId: string, _budgetMs = 60_000) {
  const before = await statusOrThrow(cfg, ownerId);
  if (before.container === "missing") return null;
  const status = before.container === "running" && before.ready
    ? before
    : await vpsComputerAction("start", cfg, ownerId);
  return status.ready ? machineFromStatus(status) : null;
}

export async function provisionCloudComputer(cfg: AppConfig, ownerId: string, _ownerName?: string) {
  const before = await statusOrThrow(cfg, ownerId).catch(() => null);
  const status = await vpsComputerAction("provision", cfg, ownerId);
  if (!status.ready) throw Object.assign(new Error(status.problem ?? "the cloud computer did not become ready"), { status: 409 });
  const join = await vpsComputerJoin(cfg, ownerId);
  return {
    boxId: status.container_id ?? status.container_name,
    machineName: status.container_name,
    reused: before?.container !== "missing",
    state: "running",
    joinUrl: join.joinUrl,
  };
}

export async function joinCloudComputer(cfg: AppConfig, ownerId: string) {
  const machine = await readyCloudComputer(cfg, ownerId, 60_000);
  if (!machine) throw new Error("the cloud computer did not wake in time — try again");
  return { joinUrl: (await vpsComputerJoin(cfg, ownerId)).joinUrl, state: machine.state };
}

/** The only join path allowed while a bot turn is active: no lifecycle or guest-process change. */
export async function joinReadyCloudComputer(cfg: AppConfig, ownerId: string) {
  const status = await statusOrThrow(cfg, ownerId);
  if (status.container === "missing") throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (status.container !== "running" || !status.ready) {
    throw Object.assign(new Error("the cloud computer is sleeping or starting — interrupt the bot before waking it"), { status: 409 });
  }
  return { joinUrl: (await vpsComputerJoin(cfg, ownerId)).joinUrl, state: "running" };
}

export async function sleepCloudComputer(cfg: AppConfig, ownerId: string) {
  const status = await statusOrThrow(cfg, ownerId);
  if (status.container === "missing") throw new Error("no computer for this bot");
  if (status.container === "running") await vpsComputerAction("stop", cfg, ownerId);
  return { ok: true };
}

export async function execOnCloudComputer(cfg: AppConfig, ownerId: string, command: string) {
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
    throw new RangeError(`command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`);
  }
  const machine = await readyCloudComputer(cfg, ownerId, 60_000);
  if (!machine) throw new Error("the cloud computer did not wake");
  const out = await runCommand(cfg, machine.id, isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

const PANEL_PATH = "/tmp/omb-panel.jpg";
export const PANEL_FRAME_WIDTH = 1920;
export const PANEL_FRAME_QUALITY = 85;
const PANEL_FRAME_FFMPEG_Q = 3;

export function panelShotCommand({ width = PANEL_FRAME_WIDTH, quality = PANEL_FRAME_QUALITY, framePath = PANEL_PATH, nativeSize = false } = {}): string {
  return [
    "export DISPLAY=${DISPLAY:-:1}",
    `f=${shellQuote(framePath)}`,
    'rm -f "$f"',
    'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
    'case "$w" in ""|*[!0-9]*) w=0;; esac',
    `scrot -o -p -q ${quality} "$f" 2>/dev/null || import -window root -quality ${quality} "$f" 2>/dev/null || ffmpeg -y -f x11grab -draw_mouse 1 -i "$DISPLAY" -frames:v 1 -q:v ${PANEL_FRAME_FFMPEG_Q} "$f" >/dev/null 2>&1`,
    ...(nativeSize ? [] : [`if [ "$w" -gt ${width} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -resize ${width}x -quality ${quality} "$f" 2>/dev/null || true; fi`]),
    'test -s "$f" && echo captured',
  ].join("; ");
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_TOO_LARGE = "the cloud computer's frame exceeds the 8 MB limit";

export async function readFileBase64(cfg: AppConfig, computer: string, path: string, signal?: AbortSignal): Promise<string | null> {
  if (!/^\/tmp\/[A-Za-z0-9._-]{1,100}$/.test(path)) throw new Error("invalid cloud computer frame path");
  const out = await runCommand(
    cfg,
    computer,
    `test -s ${shellQuote(path)} && base64 ${shellQuote(path)} 2>/dev/null | tr -d '\\n'`,
    { timeoutMs: 30_000, signal },
  );
  if (!out.ok || !out.stdout) return null;
  if (Buffer.byteLength(out.stdout, "base64") > MAX_FRAME_BYTES) throw new Error(FRAME_TOO_LARGE);
  return out.stdout;
}

export async function screenshotCloudComputer(cfg: AppConfig, ownerId: string, knownComputerId?: string, options?: { signal?: AbortSignal; nativeSize?: boolean }) {
  let computer = knownComputerId;
  if (!computer) {
    const machine = await findCloudComputer(cfg, ownerId);
    if (!machine) throw new Error("no computer for this bot yet");
    if (!READY.has(machine.state)) throw new Error(`the cloud computer is ${machine.state}`);
    computer = machine.id;
  }
  const framePath = options?.nativeSize ? `${PANEL_PATH}.model.jpg` : PANEL_PATH;
  const out = await runCommand(
    cfg,
    computer,
    options?.nativeSize ? panelShotCommand({ framePath, nativeSize: true }) : panelShotCommand({ framePath }),
    { timeoutMs: 60_000, signal: options?.signal },
  );
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the cloud computer");
  }
  const data = await readFileBase64(cfg, computer, framePath, options?.signal);
  if (!data) throw new Error("could not read the frame back from the cloud computer");
  return { png: data, format: "jpeg" };
}

export async function deleteManagedCloudComputer(
  cfg: AppConfig,
  owners: ManagedCloudOwner[],
  name: string,
  confirmName: string,
) {
  return removeManagedVpsComputer(cfg, owners, name, confirmName);
}

export { vpsContainerName };

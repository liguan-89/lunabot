import { piModelId } from "./pi-model-id.ts";
import {
  mergePiCustomCatalog,
  withPiDefaultOption,
  withoutPiCustomEnv,
} from "./pi-custom-provider.ts";
import {
  applyPiLocalCatalog,
  ensurePiCustomProvider,
  ensurePiInjectModel,
  piCatalogFromFrame,
  piInstanceEnvs,
  readPiDefaultModel,
  splitPiModel,
} from "./pi-model-catalog.ts";
export { applyPiLocalCatalog, ensurePiCustomProvider, ensurePiInjectModel, splitPiModel };
export { parsePiCatalog, preferPiInjectRows } from "./pi-model-catalog.ts";
import { RuntimeNoticeError, runtimeErrorText } from "./runtime-notice-error.ts";
// The pi coding agent (@earendil-works/pi-coding-agent) over its own stdio JSON-RPC mode
// (`pi --mode rpc --no-session`), not ACP. pi is BYOK and reads ~/.pi/agent/auth.json itself, so
// this driver holds no key; resumeCursor is pi's `sessionFile` (switch_session).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "../config.ts";
import { openStartupModelCatalog, unconfirmedModelCatalog, writeStartupModelCache } from "../startup-model-catalog.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCliBoxed, killCliTree, spawnCli } from "../procs.ts";
import { instanceEnvNames } from "../bot-box/env.ts";
import {
  deletePromptSplitReceipt,
  promptHalves,
  readPromptSplitReceipt,
  splitSessionPrompt,
  writePromptSplitReceipt,
} from "./prompt-split.ts";
import type { PromptSplitReceipt } from "./prompt-split.ts";
import { sessionIdlePolicy } from "./session-idle.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { commandSummary, toolDetailPreview } from "../tool-summary.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";

import type {
  DriverCreateInput,
  EffortLevel,
  ModelCatalog,
  PrewarmInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerOutcome,
} from "../contracts.ts";
import { EFFORT_LEVELS } from "../../shared/wire.ts";
import { newEventId, newId, TurnNotStartedError } from "../contracts.ts";
import { ASK_USER_TOOL, MAX_QUESTION_TEXT, parseAskQuestions, parseChoices, questionAnswersByQuestion } from "../../shared/ask-question.ts";
import { appendNative } from "./native.ts";
import { allowsTool, parseToolScope } from "../../shared/tool-scope.ts";
import { buildMcpServers } from "./pi-mcp-servers.ts";
import { createSidejobText } from "./pi-sidejob-text.ts";
import { PiSessionAllow, readPiApprovalRequest } from "./pi-session-allow.ts";
import { noticeFailure } from "../chat-notices.ts";

import { decodePiFrame, PiRpcChunks, piLineReader, piNativeLogMessage, readPiPromptImages } from "./pi-rpc.ts";
import { PiRunUsage, type PiUsage, type TurnUsage } from "./pi-usage.ts";
export { decodePiFrame, PiRpcChunks, piLineReader } from "./pi-rpc.ts";

const DRIVER_KIND = "piAgent";
const PI_ARGS = ["--mode", "rpc", "--no-session"];
const PI_MODEL_UPDATE_ARGS = ["update", "--models", "--no-approve"];
/** omp's RPC transport caps a frame at 1 MiB and chunks bigger ones only after the client
 *  negotiates protocol 2. Vanilla pi has no handshake frame to wait for. */
const PI_NEGOTIATE_FRAME = { id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 };
const PI_PROMPT_RE_ANCHOR_TURNS = 8;
/** How long to wait after a finished turn_end for agent_end, which some runtimes never send. */
const PI_AGENT_END_GRACE_MS = 60_000;
/** A prompt sent before pi answers new_session or switch_session runs on a session pi then replaces, so the turn waits
 *  for that answer however long it takes, and says so in the chat after this long. */
const PI_SESSION_SLOW_MS = 20_000;

/** pi answered success:false: an explicit refusal from a live runtime, not a transport failure. */
class PiRpcRefusalError extends Error {}

export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

/** Security: Pi loads its extensions from ~/.pi/agent on every start, so while the bot box is on its model list runs in
 * the box, as a bot's turn does. `allowEnv`: the keys the instance's own settings put in `env`. */
export async function fetchPiModels(
  cli: string,
  env: Record<string, string | undefined>,
  allowEnv: readonly string[] = [],
): Promise<ModelCatalog> {
  try {
    ensurePiCustomProvider(env);
  } catch {}
  const child = spawnCli(cli, PI_ARGS, { stdio: ["pipe", "pipe", "pipe"], env: withoutPiCustomEnv(env), box: { allowEnv } });
  return new Promise((resolve) => {
    let done = false;
    const fallbackDefault = readPiDefaultModel(env);
    const finish = (catalog: ModelCatalog) => {
      if (done) return;
      done = true;
      try {
        killCliTree(child);
      } catch {}
      resolve(catalog);
    };
    const timer = setTimeout(() => finish({ default: "", options: [] }), 15_000);
    timer.unref?.();
    const chunks = new PiRpcChunks();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", piLineReader((line) => {
      const frame = decodePiFrame(line, chunks);
      if (frame?.command !== "get_available_models") return false;
      clearTimeout(timer);
      finish(piCatalogFromFrame(frame, fallbackDefault) ?? { default: fallbackDefault, options: [] });
      return true;
    }));
    child.on("error", () => finish({ default: "", options: [] }));
    child.on("close", () => finish({ default: "", options: [] }));
    try {
      child.stdin.write(`${JSON.stringify(PI_NEGOTIATE_FRAME)}\n`);
      child.stdin.write(JSON.stringify({ id: "catalog", type: "get_available_models" }) + "\n");
    } catch {
      finish({ default: "", options: [] });
    }
  });
}

export async function updatePiModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  allowEnv: readonly string[] = [],
): Promise<boolean> {
  return new Promise((resolve) => {
    execCliBoxed(cli, PI_MODEL_UPDATE_ARGS, { env: withoutPiCustomEnv(env), timeout: 60_000, maxBuffer: 1024 * 1024, box: { allowEnv } }, (error) => resolve(!error));
  });
}

export interface PiConfig {
  cli: string;
  /** Full-auto: never ask before an action. Host control is unavailable in this mode. */
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): PiConfig {
  if (raw === null || raw === undefined) return { cli: "pi", fullAuto: false };
  if (typeof raw !== "object") throw new Error("pi config must be an object");
  const obj = raw as { cli?: unknown; fullAuto?: unknown };
  if (obj.cli !== undefined && typeof obj.cli !== "string") throw new Error("pi config `cli` must be a string");
  if (obj.fullAuto !== undefined && typeof obj.fullAuto !== "boolean") throw new Error("pi config `fullAuto` must be a boolean");
  return {
    cli: obj.cli && obj.cli.trim() ? obj.cli.trim() : "pi",
    fullAuto: obj.fullAuto === true,
  };
}

const EMPTY: ModelCatalog = { default: "", options: [] };

interface PiEvent {
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { role?: string; stopReason?: string; errorMessage?: string; usage?: PiUsage };
  usage?: PiUsage;
  isTerminal?: boolean;
  willRetry?: boolean;
  id?: string;
  method?: string;
  options?: unknown[];
  title?: string;
}

function piEnvironment(
  source: Record<string, string | undefined>,
  options: { keepCustom?: boolean } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, PATH: augmentedPath() };
  // pi reads provider keys from its env: an inherited key would flip billing, and workspace
  // credentials are the harness's secrets.
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return options.keepCustom ? env : withoutPiCustomEnv(env);
}

export const PiDriver: ProviderDriver<PiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "pi", supportsMultipleInstances: true, access: "custom" },
  install: {
    command: {
      darwin: "npm install -g @earendil-works/pi-coding-agent",
      linux: "npm install -g @earendil-works/pi-coding-agent",
      win32: "npm install -g @earendil-works/pi-coding-agent",
    },
    needsNode: true,
    docsUrl: "https://pi.dev",
  },
  models: EMPTY,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<PiConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const providerEnv = { ...process.env, ...input.environment };
    const { catalogEnv, piEnv } = piInstanceEnvs(instanceId, piEnvironment(providerEnv, { keepCustom: true }), providerEnv);
    let models = EMPTY;
    const readModels = async () => {
      let base = models, listed = false;
      try {
        const resolved = await fetchPiModels(config.cli, catalogEnv, instanceEnvNames(input.environment, catalogEnv));
        if (resolved.options.length) [base, listed] = [resolved, true];
      } catch {}
      try {
        const next = mergePiCustomCatalog(await applyPiLocalCatalog(base, catalogEnv), catalogEnv);
        if (next.options.length) models = withPiDefaultOption(next);
      } catch {
        if (base.options.length) models = base;
      }
      try {
        models = withPiDefaultOption(mergePiCustomCatalog(models, catalogEnv));
        if (!listed) unconfirmedModelCatalog(models);
        writeStartupModelCache(instanceId, models);
      } catch {}
    };
    const refreshModels = async () => {
      await updatePiModelCatalog(config.cli, catalogEnv, instanceEnvNames(input.environment, catalogEnv));
      await readModels();
    };
    const startupModelRefresh = (await openStartupModelCatalog({
      instanceId,
      use: (catalog) => { models = catalog; },
      current: () => models,
      refresh: readModels,
    }))?.pending ?? null;

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, {
      stop: () => Promise<void>;
      turnId: string;
      pending: Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>;
      sessionAllow: PiSessionAllow;
      child?: { stdin: { write: (s: string) => void } };
      steer?: (text: string) => Promise<SteerOutcome>;
    }>();

    /** A pi child kept warm between turns, with everything the boot fixed.
     *
     * pi's MCP extension mounts every integration and reads the tool scope and
     * approval mode *at spawn*, so a warm child is only reusable while every
     * input to that boot is unchanged. `key` is exactly that input set; a
     * different scope, approval mode, integration set, cwd, model inject file
     * or CLI closes the child and the next turn spawns a fresh one.
     */
    interface PiWarmSession {
      child: ReturnType<typeof spawnCli>;
      key: string;
      sessionFile: string | null;
      sessionReady: boolean;
      confirmedModel: string | null;
      sessionAllow: PiSessionAllow;
      idleTimer: ReturnType<typeof setTimeout> | null;
    }
    const warmSessions = new Map<string, PiWarmSession>();
    const { idleMs: SESSION_IDLE_MS } = sessionIdlePolicy("PI");

    const closeWarmSession = (threadId: string, reason: string) => {
      const warm = warmSessions.get(threadId);
      if (!warm) return;
      warmSessions.delete(threadId);
      if (warm.idleTimer) clearTimeout(warm.idleTimer);
      try {
        warm.child.stdin.end();
      } catch {}
      try {
        killCliTree(warm.child);
      } catch {}
      void reason;
    };

    /** A child spawned by prewarm before its turn's sendTurn ran, keyed by the contract it was
     * booted from. sendTurn takes it over on a contract match; anything else — a contract change,
     * a cancelled setup that never reaches sendTurn, the expiry — kills it and removes its
     * credential temp dir. */
    interface PiPendingSpawn {
      child: ReturnType<typeof spawnCli>;
      key: string;
      mcpTempDir: string;
      scopeReadyPath: string | undefined;
      expiry: ReturnType<typeof setTimeout>;
    }
    const pendingSpawns = new Map<string, PiPendingSpawn>();
    const configuredPrewarmMs = Number(process.env.OMB_PI_PREWARM_MS);
    const PREWARM_EXPIRE_MS = Number.isFinite(configuredPrewarmMs) && configuredPrewarmMs > 0 ? configuredPrewarmMs : 60_000;

    const dropPending = (threadId: string, pending: PiPendingSpawn) => {
      if (pendingSpawns.get(threadId) !== pending) return;
      pendingSpawns.delete(threadId);
      clearTimeout(pending.expiry);
      try {
        pending.child.stdin.end();
      } catch {}
      void killCliTree(pending.child).finally(() => {
        try {
          rmSync(pending.mcpTempDir, { recursive: true, force: true });
        } catch {}
      });
    };

    const stopAll = async () => {
      const results = await Promise.allSettled([...active.values()].map(({ stop }) => Promise.resolve().then(stop)));
      for (const threadId of Array.from(warmSessions.keys())) closeWarmSession(threadId, "stop all");
      for (const [threadId, pending] of Array.from(pendingSpawns)) dropPending(threadId, pending);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    };

    /** Everything the child's boot fixed. A turn whose contract differs must
     * not inherit the previous child's grants, scope or model. */
    const spawnContract = (turn: PrewarmInput) => {
      const selection = parseToolScope(turn.toolScope);
      if (!selection.ok) throw new Error(selection.error);
      // A confined turn gets no pi-native tool at all — no shell, no file reads anywhere — and the
      // harness-MCP gate below then only lets through what its own scope checks allow.
      const toolScope = turn.guestConfined
        ? { ...selection.scope, deny: [...(selection.scope?.deny ?? []), "native:*"] }
        : selection.scope;
      const mcpServers = buildMcpServers(turn);
      const askUser = toolScope === undefined || allowsTool(toolScope, { kind: "native", name: ASK_USER_TOOL });
      const key = JSON.stringify({
        cli: config.cli,
        cwd: turn.cwd ?? null,
        toolScope: toolScope ?? null,
        approvalMode: turn.approvalMode ?? null,
        askUser,
        model: turn.model ?? null,
        mcpServers: mcpServers ?? null,
      });
      return { toolScope, mcpServers, askUser, key };
    };

    /** The fresh spawn a turn with no reusable child pays: the credential-bearing MCP config in a
     * 0600 temp file removed once the child has read it (never argv), then the CLI. Its extension
     * mounts the servers and reads the tool scope and the approval mode at boot. */
    const spawnFresh = (contract: ReturnType<typeof spawnContract>, turn: PrewarmInput) => {
      // Before any credential-bearing temp file, so a model setup failure leaves nothing to clean up.
      try {
        ensurePiCustomProvider(piEnv);
      } catch {}
      if (typeof turn.model === "string" && turn.model) {
        ensurePiInjectModel(turn.model, piEnv);
      }
      const mcpTempDir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-"));
      const scopeReadyPath = contract.toolScope !== undefined ? join(mcpTempDir, "scope-ready.json") : undefined;
      try {
        writeFileSync(join(mcpTempDir, "mcp.json"), JSON.stringify({ mcpServers: contract.mcpServers ?? {}, toolScope: contract.toolScope, scopeReadyPath, approvalMode: turn.approvalMode, askUser: contract.askUser }), { mode: 0o600 });
      } catch (err) {
        // A partial file could still hold credentials.
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
      // spawnCli can throw synchronously, before the caller could remove the credential file.
      try {
        const child = spawnCli(config.cli, [...PI_ARGS, "-e", SPAWNED_PROXIES.piMcpExtension], {
          // The box has its own /tmp: mount the turn's MCP config (and its scope receipt) so pi's extension can read them.
          box: { rw: [mcpTempDir] },
          stdio: ["pipe", "pipe", "pipe"],
          cwd: turn.cwd,
          env: piEnvironment({
            ...piEnv,
            // The same identity the agents server sees, so an extension or a fixture can tell whose turn this is.
            ...(turn.botId ? { OMB_BOT_ID: turn.botId } : {}),
            OMB_THREAD_ID: turn.threadId,
            // The level this child was booted at, so an extension or a fixture can report what a turn ran under.
            ...(turn.approvalMode ? { OMB_APPROVAL_MODE: turn.approvalMode } : {}),
            OMB_MCP_CONFIG: join(mcpTempDir, "mcp.json"),
          }),
        }, "bot");
        // Kept for the child's whole life: the per-turn listeners are detached
        // between turns, and an 'error' event on a stream with no listener
        // takes the process down. A warm child can emit one while idle.
        child.on("error", () => {});
        child.stdin.on("error", () => {});
        return { child, mcpTempDir, scopeReadyPath };
      } catch (err) {
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
    };

    const prewarm = (turn: PrewarmInput) => {
      // A reset turn boots its own child on purpose, and a busy thread's turn cannot start until
      // the running one settles: neither has a spawn worth overlapping.
      if (turn.sessionReset || active.has(turn.threadId)) return;
      let contract: ReturnType<typeof spawnContract>;
      try {
        contract = spawnContract(turn);
      } catch {
        // Best-effort: sendTurn reports the same contract error to the turn itself.
        return;
      }
      const warm = warmSessions.get(turn.threadId);
      if (warm && warm.key === contract.key && warm.child.exitCode === null && warm.child.signalCode === null) return;
      const standing = pendingSpawns.get(turn.threadId);
      if (standing?.key === contract.key) return;
      if (standing) dropPending(turn.threadId, standing);
      try {
        const spawn = spawnFresh(contract, turn);
        const pending: PiPendingSpawn = {
          ...spawn,
          key: contract.key,
          expiry: setTimeout(() => dropPending(turn.threadId, pending), PREWARM_EXPIRE_MS),
        };
        pending.expiry.unref?.();
        pendingSpawns.set(turn.threadId, pending);
      } catch {
        // Best-effort: sendTurn reports the spawn failure to the turn itself.
      }
    };

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      if (startupModelRefresh) await startupModelRefresh;
      const { threadId } = turn;
      const contract = spawnContract(turn);
      const { toolScope, key: poolKey } = contract;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const fullAuto = turn.approvalMode === undefined ? config.fullAuto : false;
      // Host control always routes through the permission card, full-auto or not.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && fullAuto) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = newId();
      // Whether the prompt frame went out: past this point the attempt may have
      // reached a model, so it is the turn's, and never replayed on a backup.
      let promptSent = false;
      /** What ended the child before the prompt, for the startup-recovery reject. */
      let prePromptFailure: string | undefined;
      // Automatic recovery replays only a turn that provably never started; the
      // harness asks for that with startupRecovery, and every pre-prompt exit
      // below then rejects the dispatch instead of settling a failed turn.
      const recoverOnStart = turn.startupRecovery === true;
      const prePromptQuiet = () => recoverOnStart && !promptSent;
      const pending = new Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>();
      const askTimers = new Set<ReturnType<typeof setTimeout>>();
      let settled = false;
      /** Mirrors the settle outcome; read at the pre-prompt checkpoints. */
      let settledOk = true;
      /** Whether the child may outlive this turn (pooling); stop() clears it. */
      let keepChild = true;
      let completion: Promise<void> | null = null;
      let endStopReason: string | undefined;
      const runUsage = new PiRunUsage();
      let completionOutcome: { ok: boolean; stopReason: string; cost?: number; usage?: TurnUsage } | null = null;
      let endErrorMessage: string | undefined;
      let agentEndTimer: ReturnType<typeof setTimeout> | null = null;
      const images = readPiPromptImages(turn);

      const warm = warmSessions.get(threadId);
      const reuse = Boolean(
        warm &&
          !turn.sessionReset &&
          warm.key === poolKey &&
          warm.child.exitCode === null &&
          warm.child.signalCode === null,
      );
      let mcpTempDir: string | null = null;
      let scopeReadyPath: string | undefined;
      let child: ReturnType<typeof spawnCli>;
      let sessionFile: string | null;
      let sessionReady: boolean;
      let confirmedModel: string | null;
      let sessionAllow: PiSessionAllow;
      if (reuse && warm) {
        const stale = pendingSpawns.get(threadId);
        if (stale) dropPending(threadId, stale);
        child = warm.child;
        sessionFile = warm.sessionFile;
        sessionReady = warm.sessionReady;
        confirmedModel = warm.confirmedModel;
        sessionAllow = warm.sessionAllow;
        if (warm.idleTimer) {
          clearTimeout(warm.idleTimer);
          warm.idleTimer = null;
        }
        warmSessions.delete(threadId);
      } else {
        closeWarmSession(threadId, "spawn contract changed");
        let pending = pendingSpawns.get(threadId);
        if (pending && (pending.key !== poolKey || pending.child.exitCode !== null || pending.child.signalCode !== null)) {
          dropPending(threadId, pending);
          pending = undefined;
        }
        if (pending) {
          pendingSpawns.delete(threadId);
          clearTimeout(pending.expiry);
          child = pending.child;
          mcpTempDir = pending.mcpTempDir;
          scopeReadyPath = pending.scopeReadyPath;
        } else {
          const spawn = spawnFresh(contract, turn);
          child = spawn.child;
          mcpTempDir = spawn.mcpTempDir;
          scopeReadyPath = spawn.scopeReadyPath;
        }
        sessionFile = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        sessionReady = false;
        confirmedModel = null;
        sessionAllow = new PiSessionAllow();
      }
      const freshSpawn = !reuse;
      let assistantText = "";
      let compactionObserved = false;
      const responseWaiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }>();
      // Steers correlate by a unique id, so concurrent steers never share or overwrite a waiter.
      let steerSeq = 0;
      const rejectWaiters = (err: Error) => {
        for (const waiter of responseWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        responseWaiters.clear();
      };
      const awaitResponse = (command: string, timeoutMs = 20_000, key = command) =>
        new Promise<unknown>((resolve, reject) => {
          // A child that died before this waiter was registered has nobody left
          // to reject it: answer from the death the handlers already recorded.
          if (child.exitCode !== null || child.signalCode !== null) {
            reject(new Error(prePromptFailure ?? "pi process exited before replying"));
            return;
          }
          const timer = timeoutMs === Infinity ? undefined : setTimeout(() => {
            responseWaiters.delete(key);
            reject(new Error(`pi ${command} timed out`));
          }, timeoutMs);
          timer?.unref?.();
          responseWaiters.set(key, { resolve, reject, timer });
        });
      const onStdinError = () => rejectWaiters(new Error("pi stdin closed"));
      child.stdin.on("error", onStdinError);
      const send = (obj: Record<string, unknown>) => {
        appendNative(threadId, { dir: "out", source: "pi.rpc", msg: piNativeLogMessage(obj) });
        child.stdin.write(JSON.stringify(obj) + "\n");
      };
      // Vanilla pi refuses the unknown command; no waiter is keyed for the reply.
      // Only a fresh child needs it: a reused one was negotiated at spawn.
      if (freshSpawn) send(PI_NEGOTIATE_FRAME);

      const flushAssistantText = () => {
        const text = assistantText;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
      };

      const settle = (ok: boolean, stopReason?: string | null, usage = runUsage.usage): Promise<void> => {
        if (completion) return completion;
        const outcome = completionOutcome ??= {
          ok, stopReason: stopReason ?? (ok ? "end_turn" : "failed"),
          ...(usage ? { usage } : {}),
          ...(runUsage.cost === undefined ? {} : { cost: runUsage.cost }),
        };
        settled = true;
        settledOk = ok;
        if (agentEndTimer) {
          clearTimeout(agentEndTimer);
          agentEndTimer = null;
        }
        for (const timer of askTimers) clearTimeout(timer);
        askTimers.clear();
        pending.clear();
        sessionAllow.dropTurn();
        // `keep` is decided once: a warm child survives an ordinary completion
        // (that is the whole point), and every other exit — an explicit stop, a
        // dead or unconfirmed child — takes the kill path.
        const keep = keepChild && child.exitCode === null && child.signalCode === null;
        completion = (async () => {
          rejectWaiters(new Error("pi turn ended"));
          if (keep) {
            detachHandlers();
            flushAssistantText();
            const warm: PiWarmSession = {
              child,
              key: poolKey,
              sessionFile,
              sessionReady,
              confirmedModel,
              sessionAllow,
              idleTimer: null,
            };
            warm.idleTimer = setTimeout(() => closeWarmSession(threadId, "idle"), SESSION_IDLE_MS);
            warm.idleTimer.unref?.();
            warmSessions.set(threadId, warm);
            active.delete(threadId);
            // The same quiet rule as the kill path below: a pre-prompt failure
            // under startup recovery is the dispatch's rejection to report.
            if (!(ok === false && prePromptQuiet())) {
              emit({
                ...base(threadId, turnId),
                type: "turn.completed",
                ...outcome,
              });
            }
            return;
          }
          try {
            child.stdin.end();
          } catch {}
          // The TERM grace lets Pi end the detached tool processes it started; a CLI that ignores TERM is killed after it.
          if (!await killCliTree(child)) throw new Error("Pi process termination could not be confirmed");
          if (mcpTempDir) {
            try {
              rmSync(mcpTempDir, { recursive: true, force: true });
            } catch {}
          }
          // Ownership outlasts the stop: this thread has no turn again until its CLI is gone, so a stop that cannot be
          // confirmed leaves it owned (and the next start reconciles it).
          active.delete(threadId);
          flushAssistantText();
          // A pre-prompt failure under startup recovery stays quiet: the
          // dispatch rejects with TurnNotStartedError and the harness owns the
          // failure row and the replay, so no completion may publish first. A
          // Stop in the same window is a cancellation, not a failure, and still
          // publishes.
          if (!(ok === false && prePromptQuiet())) {
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ...outcome,
            });
          }
        })();
        void completion.catch((error: Error) => {
          completion = null;
          emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message });
        });
        return completion;
      };

      const finishRun = () => {
        const sr = endStopReason;
        if (sr === "error" || sr === "failed") {
          // What the turn already said is part of its transcript, so it lands above the failure row rather than after it.
          flushAssistantText();
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: String(endErrorMessage ?? "pi turn failed").slice(0, 2_000),
          });
          settle(false, "failed", runUsage.usage);
          return;
        }
        settle(true, sr === "cancelled" || sr === "aborted" ? "cancelled" : "end_turn", runUsage.usage);
      };

      const stop = () => {
        keepChild = false;
        try {
          send({ type: "abort" });
        } catch {}
        // pi cancels cleanly; a Stop is never a failed turn. A harness stop (the loop guard) says why in its own row.
        return settle(true, "cancelled");
      };

      // pi queues a steer into the running agent without aborting the step, answers success only after
      // session.steer() accepted it, and echoes each frame's id.
      const steerActiveTurn = async (text: string): Promise<SteerOutcome> => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return "refused";
        let ack: Promise<unknown>;
        try {
          const id = `steer:${++steerSeq}`;
          ack = awaitResponse("steer", 20_000, id);
          send({ type: "steer", id, message: text });
        } catch {
          return "refused";
        }
        try {
          await ack;
          return "steered";
        } catch (error) {
          return error instanceof PiRpcRefusalError ? "refused" : "indeterminate";
        }
      };
      active.set(threadId, { stop, turnId, pending, sessionAllow, child, steer: steerActiveTurn });

      const onEvent = (evt: PiEvent) => {
        appendNative(threadId, { dir: "in", source: "pi.rpc", msg: evt });
        if (settled) return;
        switch (evt.type) {
          case "response": {
            const key = typeof evt.id === "string" && responseWaiters.has(evt.id) ? evt.id : evt.command;
            if (key && responseWaiters.has(key)) {
              const waiter = responseWaiters.get(key)!;
              responseWaiters.delete(key);
              clearTimeout(waiter.timer);
              if (evt.success) waiter.resolve(evt.data);
              else waiter.reject(new PiRpcRefusalError(`pi ${evt.command} failed`));
            }
            return;
          }
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (!e) return;
            // A turn can say a working note and later its answer as separate assistant messages: a new text block
            // ends the one before it, as a tool call does.
            if (e.type === "text_start") {
              flushAssistantText();
            } else if (e.type === "text_delta" && typeof e.delta === "string") {
              assistantText += e.delta;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: e.delta });
            } else if (e.type === "thinking_delta" && typeof e.delta === "string") {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: e.delta });
            }
            return;
          }
          case "tool_execution_start": {
            flushAssistantText();
            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: evt.toolCallId,
              title: String(evt.toolName ?? "tool").slice(0, 80),
              summary: commandSummary(evt.args),
              input: toolDetailPreview(evt.args),
            });
            return;
          }
          case "tool_execution_end": {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "tool",
              itemId: evt.toolCallId,
              ok: !evt.isError,
              output: toolDetailPreview(evt.result),
            });
            // A tool may return an image (a chart, a screenshot): it belongs to the turn as a tool-made image, as the
            // retired engine's tool results did.
            for (const image of extractMcpImages(evt.result)) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_image", data: image.data, fromTool: true });
            }
            return;
          }
          case "extension_ui_request": {
            // pi floods setWidget/setStatus; only select/confirm/input wait for an answer.
            if (evt.method === "select" || evt.method === "confirm" || evt.method === "input") {
              flushAssistantText();
              const reqId = evt.id ?? newId();
              const isSelect = evt.method === "select";
              const isQuestion = isSelect || evt.method === "input";
              const selectOptions: string[] = isSelect && Array.isArray(evt.options)
                ? evt.options.filter((option): option is string => typeof option === "string") : [];
              const title = String(evt.title ?? (isQuestion ? "pi has a question" : "pi wants confirmation")).slice(0, isQuestion ? MAX_QUESTION_TEXT : 200);
              // A gated confirm carries the call's input JSON as `message` — that is what the card must show.
              const detail = !isQuestion && typeof evt.message === "string" ? evt.message : "";
              const { commandLine, risk } = readPiApprovalRequest(evt, { title, isQuestion, controlsHost });
              if (!isQuestion && sessionAllow.mayAutoAllow(risk)) {
                send({ type: "extension_ui_response", id: reqId, confirmed: true });
                emit({ ...base(threadId, turnId), requestId: reqId, type: "request.resolved", behavior: "allow", source: "auto" });
                return;
              }
              const summary = detail ? `${title} — ${commandLine ?? detail}`.slice(0, 600) : title;
              const question = isSelect
                ? (parseAskQuestions({
                    questions: [{ question: summary, options: selectOptions }],
                  }) ?? [])[0]
                : undefined;
              const choices = question?.options.length ? question.options.map((option) => option.label) : undefined;
              let timer: ReturnType<typeof setTimeout> | undefined;
              if (!isQuestion) sessionAllow.record(reqId, risk);
              // Register BEFORE emitting: the harness may auto-approve inside its synchronous request.opened listener.
              pending.set(reqId, (decision) => {
                if (timer) {
                  clearTimeout(timer);
                  askTimers.delete(timer);
                }
                if (decision.behavior === "deny") send({ type: "extension_ui_response", id: reqId, cancelled: true });
                else if (isQuestion) {
                  const value = question
                    ? questionAnswersByQuestion(decision.message ?? "", [question])[question.question] ?? decision.message ?? ""
                    : decision.message ?? "";
                  // pi expects the original option, not the capped display label; never guess between two.
                  const matched = selectOptions.filter(option => parseChoices([option], 1)?.[0] === value);
                  send(matched.length > 1
                    ? { type: "extension_ui_response", id: reqId, cancelled: true }
                    : { type: "extension_ui_response", id: reqId, value: matched[0] ?? value });
                }
                else send({ type: "extension_ui_response", id: reqId, confirmed: true });
              });
              if (!isQuestion) {
                timer = setTimeout(() => {
                  if (timer) askTimers.delete(timer);
                  if (!pending.delete(reqId)) return;
                  sessionAllow.forget(reqId);
                  send({ type: "extension_ui_response", id: reqId, cancelled: true });
                  emit({ ...base(threadId, turnId), requestId: reqId, type: "request.resolved", behavior: "deny", source: "timeout" });
                }, 15 * 60_000);
                askTimers.add(timer);
                timer.unref?.();
              }
              emit({
                ...base(threadId, turnId),
                requestId: reqId,
                type: "request.opened",
                requestType: isQuestion ? "question" : "permission",
                tool: risk.toolKey,
                summary,
                ...(!isQuestion && !risk.dangerous && !risk.controlsHost ? { allowSession: true } : {}),
                ...(commandLine ? { commandLine } : {}),
                ...(commandLine && turn.cwd ? { command: { command: commandLine, cwd: turn.cwd } } : {}),
                ...(choices ? { choices } : {}),
                ...(question ? { questions: [question] } : {}),
              });
            }
            return;
          }
          case "compaction_start":
          case "compaction_end":
          case "auto_compaction_start":
          case "auto_compaction_end": {
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = null;
            if (sessionReady && sessionFile) { // pi compaction (manual or automatic) can absorb the turn that carried the standing prompt
              compactionObserved = true;
              deletePromptSplitReceipt("pi", JSON.stringify([threadId, sessionFile]));
            }
            if (evt.type.endsWith("compaction_end") && typeof (evt as { result?: { summary?: unknown } }).result?.summary === "string" && /\S/.test((evt as { result: { summary: string } }).result.summary) && !(evt as { aborted?: boolean }).aborted && !(evt as { errorMessage?: string }).errorMessage) { flushAssistantText(); emit({ ...base(threadId, turnId), type: "context.compacted" }); }
            return;
          }
          case "message_end":
            if (evt.message?.role === "assistant") runUsage.add(evt.message.usage);
            return;
          case "turn_end":
          {
            // A killed child can still flush one buffered frame after the turn settled.
            if (settled) return;
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = null;
            const sr = evt.message?.stopReason;
            runUsage.endTurn(evt.usage ?? evt.message?.usage);
            // toolUse: pi ran a tool and auto-continues; the next turn_end carries the outcome.
            if (sr === "toolUse" || sr === "tool_use" || sr === "tool_calls") return;
            endStopReason = sr;
            endErrorMessage = evt.message?.errorMessage;
            // pi can schedule maintenance (overflow-recovery compaction) after the final turn_end;
            // only agent_end proves the session is done rewriting itself.
            agentEndTimer = setTimeout(finishRun, PI_AGENT_END_GRACE_MS);
            agentEndTimer.unref?.();
            return;
          }
          case "turn_start":
          case "agent_start": {
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = null;
            return;
          }
          case "agent_end": {
            // Non-terminal agent_end: upstream pi sets willRetry: true before an automatic retry; the omp
            // fork sets isTerminal: false while maintenance or async delivery is scheduled.
            if (agentEndTimer) clearTimeout(agentEndTimer);
            agentEndTimer = null;
            if (evt.isTerminal === false || evt.willRetry === true) return;
            finishRun();
            return;
          }
          case "agent_settled": {
            // upstream pi's explicit fully-settled guarantee: no retry or queued continuation remains.
            if (agentEndTimer) {
              clearTimeout(agentEndTimer);
              agentEndTimer = null;
            }
            finishRun();
            return;
          }
          default:
            return;
        }
      };

      const chunks = new PiRpcChunks();
      const onStdout = piLineReader((line) => {
        const frame = decodePiFrame(line, chunks);
        if (!frame) return;
        try {
          onEvent(frame as unknown as PiEvent);
        } catch {}
      });
      const onChildError = (err: NodeJS.ErrnoException) => {
        const fail = describeSpawnFailure(err, config.cli, turn.cwd);
        prePromptFailure = fail.message;
        rejectWaiters(new Error(fail.message));
        // Quiet: the message rides the TurnNotStartedError the dispatch rejects with.
        if (!prePromptQuiet()) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: fail.message, setup: fail.setup });
        }
        settle(false);
      };
      const onChildClose = () => {
        prePromptFailure ??= "pi process exited before replying";
        rejectWaiters(new Error("pi process exited before replying"));
        settle(false);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onStdout);
      child.on("error", onChildError);
      child.on("close", onChildClose);
      /** Detach this turn's listeners, so a child kept for the next turn
       * cannot call back into a settled one. */
      const detachHandlers = () => {
        child.stdout.off("data", onStdout);
        child.stdin.off("error", onStdinError);
        child.off("error", onChildError);
        child.off("close", onChildClose);
      };

      emit({ ...base(threadId, turnId), type: "turn.started" });

      let sessionId: string | null = sessionFile;
      let sessionOpened = false;
      if (!freshSpawn) {
        // The warmed child already holds this session: reuse it rather than
        // making pi recreate (or re-read) the same conversation.
        sessionOpened = sessionReady;
      } else {
        try {
          const command = sessionFile ? "switch_session" : "new_session";
          const hsPromise = awaitResponse(command, Infinity);
          send(sessionFile ? { type: "switch_session", sessionPath: sessionFile } : { type: "new_session" });
          const slow = setTimeout(() => emit({ ...base(threadId, turnId), type: "runtime.notice", ...noticeFailure("chat.notice.piSessionSlow") }), PI_SESSION_SLOW_MS);
          const hs = (await hsPromise.finally(() => clearTimeout(slow))) as { sessionFile?: string; sessionId?: string } | undefined;
          if (hs?.sessionFile) sessionFile = hs.sessionFile;
          sessionId = sessionFile ?? hs?.sessionId ?? null;
          sessionReady = true;
          sessionOpened = true;
        } catch {
          // pi --no-session accepts a prompt without an explicit session.
        }
      }
      if (settled) {
        // The child ended the attempt before the prompt went out: a recoverable
        // start-up failure, so the dispatch rejects and the harness replays it.
        // A Stop in the same window settled ok and stays a cancellation.
        if (prePromptQuiet() && !settledOk) {
          throw new TurnNotStartedError(turnId, prePromptFailure ?? "pi exited before the turn started");
        }
        return { turnId };
      }

      const chosen = typeof turn.model === "string" ? splitPiModel(turn.model) : null;
      if (chosen && (freshSpawn || !confirmedModel)) {
        try {
          const modelPromise = awaitResponse("set_model");
          send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId });
          confirmedModel = piModelId(await modelPromise);
          if (!confirmedModel) throw new RuntimeNoticeError("Pi did not confirm the selected model", "chat.notice.piModelNotConfirmed");
        } catch (error) {
          const message = prePromptFailure ?? String((error as Error).message);
          if (prePromptQuiet()) {
            if (!settled) await settle(false);
            // The model refusal is a setup failure: the harness replays the
            // turn on its backup instead of reporting a dead turn.
            throw new TurnNotStartedError(turnId, message);
          }
          if (!settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: String((error as Error).message), text: runtimeErrorText(error) });
            await settle(false);
          }
          return { turnId };
        }
      }
      if (!chosen && freshSpawn) {
        try {
          const statePromise = awaitResponse("get_state");
          send({ type: "get_state" });
          const state = await statePromise as { model?: unknown } | undefined;
          confirmedModel = piModelId(state?.model);
        } catch {}
      }
      if (settled) {
        // The child ended the attempt before the prompt went out: a recoverable
        // start-up failure, so the dispatch rejects and the harness replays it.
        // A Stop in the same window settled ok and stays a cancellation.
        if (prePromptQuiet() && !settledOk) {
          throw new TurnNotStartedError(turnId, prePromptFailure ?? "pi exited before the turn started");
        }
        return { turnId };
      }
      if (sessionOpened) emit({ ...base(threadId, turnId), type: "session.started", sessionId, model: confirmedModel });

      // After the model: the supported level set is model-dependent.
      if (turn.effort) {
        try {
          const levelPromise = awaitResponse("set_thinking_level");
          send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) });
          await levelPromise;
        } catch {}
      }
      if (settled) {
        // The child ended the attempt before the prompt went out: a recoverable
        // start-up failure, so the dispatch rejects and the harness replays it.
        // A Stop in the same window settled ok and stays a cancellation.
        if (prePromptQuiet() && !settledOk) {
          throw new TurnNotStartedError(turnId, prePromptFailure ?? "pi exited before the turn started");
        }
        return { turnId };
      }

      if (scopeReadyPath) {
        let ready = false;
        try {
          const receipt = JSON.parse(readFileSync(scopeReadyPath, "utf8")) as { ok?: unknown; toolScope?: unknown };
          ready = receipt.ok === true && JSON.stringify(receipt.toolScope) === JSON.stringify(toolScope);
        } catch { /* Missing or malformed readiness is never a grant. */ }
        if (!ready) {
          const message = "Pi tool selection enforcement is unavailable. Update Pi and check the Luna Bot extension before retrying.";
          emit({ ...base(threadId, turnId), type: "runtime.error", message });
          settle(false);
          throw new Error(message);
        }
      }

      // The extension mounted every server and wrote its scope receipt at
      // boot, and both have been checked above: the credential-bearing config
      // is not needed for the rest of this child's life.
      if (mcpTempDir) {
        try {
          rmSync(mcpTempDir, { recursive: true, force: true });
        } catch {}
        mcpTempDir = null;
      }

      const halves = promptHalves(turn);
      let message: string;
      let pendingReceipt: { key: string; receipt: PromptSplitReceipt } | null = null;
      if (halves.stable !== null && sessionReady && sessionFile) {
        const receiptKey = JSON.stringify([threadId, sessionFile]);
        const composed = splitSessionPrompt(
          halves.stable,
          halves.volatile,
          readPromptSplitReceipt("pi", receiptKey),
          turn.system,
          turn.text,
          Boolean(turn.mentionTurn),
          PI_PROMPT_RE_ANCHOR_TURNS,
        );
        message = composed.text;
        pendingReceipt = { key: receiptKey, receipt: composed.receipt };
      } else {
        message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      }
      try {
          // pi answers the prompt only after preflight accepts it, and rejects it while a compaction runs.
        const accepted = awaitResponse("prompt", 120_000);
        send({ type: "prompt", message, ...(images.length ? { images } : {}) });
        // The attempt is on the record from here: a refusal or a crash past this
        // point is the turn's own failure, never a backup replay.
        promptSent = true;
        void accepted.then(
          () => {
            if (!pendingReceipt || compactionObserved) return;
            try {
              writePromptSplitReceipt("pi", pendingReceipt.key, pendingReceipt.receipt);
            } catch {}
          },
          (err: Error) => {
            if (settled) return;
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: String(err?.message ?? err).slice(0, 2_000),
            });
            settle(false);
          },
        );
      } catch (err) {
        const message = String((err as Error)?.message ?? err).slice(0, 2_000);
        // The frame never went out: a recoverable start-up failure, same as a
        // child that died earlier in the setup.
        if (prePromptQuiet()) {
          if (!settled) await settle(false);
          throw new TurnNotStartedError(turnId, prePromptFailure ?? message);
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message,
        });
        settle(false);
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        const child = spawnCli(config.cli, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: piEnvironment({ ...process.env, ...input.environment }),
        });
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => (out += c));
        const timer = setTimeout(() => {
          try {
            killCliTree(child);
          } catch {}
          resolve(null);
        }, 8000);
        timer.unref?.();
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(out.trim() || null);
        });
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // pi manages its own credentials; there is no sign-in to probe.
      return { state: "available", version, authenticated: true };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      ...(startupModelRefresh ? { startupModelRefresh } : {}),
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          // pi core has no MCP client of its own.
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          customMcp: true,
          browserMcp: true,
          dataMcp: true, emailMcp: true, deviceMcp: true,
          localComputerMcp: true,
          images: true,
          nativeImageInput: true,
          // pi rejects an unsupported level and the turn keeps the engine default.
          effortLevels: EFFORT_LEVELS,
          queueing: true, askTool: { kind: "native", name: "ask_user" },
          // A guest turn runs with every native tool denied and without the owner's
          // custom MCP connectors (see sendTurn and buildMcpServers).
          guestTurns: "confined",
        },
        sendTurn,
        prewarm,
        interruptTurn: async (threadId) => { await active.get(threadId)?.stop(); },
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          entry.pending.delete(requestId);
          entry.sessionAllow.noteDecision(requestId, decision);
          answer({ behavior: decision.behavior, message: decision.message });
          emit({
            ...base(threadId, entry.turnId),
            requestId,
            type: "request.resolved",
            behavior: decision.behavior,
            source: decision.source ?? "user",
          });
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        steer: async (threadId, text) => {
          const entry = active.get(threadId);
          return entry?.steer ? await entry.steer(text) : "refused";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll,
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: createSidejobText({ sendTurn, active, listeners, defaultModel: models.default }),
      dispose: async () => {
        try {
          await stopAll();
        } finally {
          listeners.clear();
        }
      },
    };
  },
};

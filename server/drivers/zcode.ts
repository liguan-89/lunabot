// ZCode — the ZCode CLI (`zcode app-server`) as a native engine.
//
// ZCode speaks its own "ZCode Protocol" over stdio: one JSON object per line,
// no `jsonrpc` field, and both directions can open requests (server→client
// ones carry string ids like `server-1` and must be answered). This driver
// owns one long-lived app-server child per instance and one session per
// thread; the session id is the resumeCursor the harness persists.
//
// The wire facts are documented in docs/zcode-engine-protocol.md.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { DATA_DIR, PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath, findCliCandidates, userHome } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { openStartupModelCatalog } from "../startup-model-catalog.ts";
import { appendNative } from "./native.ts";
import { acpMcpServers } from "./turn-mcp.ts";
import { parseAskQuestions, questionAnswersByQuestion, type AskQuestion } from "../../shared/ask-question.ts";

export const ZCODE_DRIVER_KIND = "zcodeAgent";

/** The only server→client request this driver answers. Anything else the
 * child raises (official MCP auth headers, telemetry) is dropped: the desktop
 * leaves those unanswered too, and a missing answer never blocks the runtime. */
export const ZCODE_ANSWERABLE_REQUESTS: ReadonlySet<string> = new Set(["session/requestRuntimePreferences"]);
export const ZCODE_RUNTIME_PREFERENCES = { nativeSearchEnhancementsEnabled: false };

/** Executable names only: a bare command resolved on PATH, or an absolute
 * path to a real file. Anything carrying a scheme is refused before it can
 * reach a spawn. */
const SAFE_EXECUTABLE = /^[A-Za-z0-9._/@+-]+$/;

export interface ZcodeConfig {
  /** CLI executable or absolute path. There is no standalone installer: the
   * desktop app ships the CLI as `ZCode.app/.../zcode.cjs`, which is why the
   * default falls back to that bundle on macOS. */
  cli: string;
  /** Ask/Auto is not wired to ZCode's approval surface: a session only runs
   * unattended in `yolo` mode, so a bot must opt into full access. */
  fullAuto: boolean;
}

export function decodeZcodeConfig(raw: unknown): ZcodeConfig {
  if (raw === null || raw === undefined) return { cli: "zcode", fullAuto: false };
  if (typeof raw !== "object") throw new Error("zcode config must be an object");
  const obj = raw as { cli?: unknown; fullAuto?: unknown };
  if (obj.cli !== undefined && typeof obj.cli !== "string") throw new Error("zcode config `cli` must be a string");
  if (obj.fullAuto !== undefined && typeof obj.fullAuto !== "boolean") throw new Error("zcode config `fullAuto` must be a boolean");
  return { cli: obj.cli && obj.cli.trim() ? obj.cli.trim() : "zcode", fullAuto: obj.fullAuto === true };
}

/** The config names an executable, never a location to fetch from. Refusing
 * anything scheme-shaped keeps a configured string from being treated as a
 * network target, and an absolute path must resolve to a real file. */
export function zcodeExecutable(raw: string): string {
  const cli = raw.trim();
  if (!cli || !SAFE_EXECUTABLE.test(cli)) {
    throw new Error("zcode config `cli` must be an executable name or an absolute file path");
  }
  if (isAbsolute(cli) && (!existsSync(cli) || !statSync(cli).isFile())) {
    throw new Error(`zcode config \`cli\` is not a file: ${cli}`);
  }
  return cli;
}

/** How to actually start the CLI: a command word and any fixed leading args.
 * The bundled CLI is a CommonJS file, not an executable, so it is started as
 * `node zcode.cjs …` rather than spawned on its own. */
export interface ZcodeLaunch {
  command: string;
  args: string[];
  /** Extra child env the launch needs (`ELECTRON_RUN_AS_NODE` in the app). */
  env: Record<string, string>;
}

const NODE_SCRIPT = /\.(?:cjs|mjs|js)$/i;

function viaNode(script: string): ZcodeLaunch {
  return {
    command: process.execPath,
    args: [script],
    // The packaged server runs on Electron, whose binary only acts as node
    // with this flag; in a checkout process.execPath already is node.
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

/** Where the ZCode desktop app bundles its CLI. Only the macOS layout is
 * known; elsewhere a `zcode` on PATH or an explicit path is the route. */
export function zcodeBundlePaths(env: Record<string, string | undefined> = process.env): string[] {
  if (process.platform !== "darwin") return [];
  return [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    join(userHome(env), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
  ];
}

/** Resolve the configured CLI to something spawnable. A bare `zcode` is
 * looked up on the augmented PATH first; when that finds nothing, the macOS
 * app bundle takes over — the desktop app is already installed, so asking the
 * person to "install the CLI" has no command behind it. */
export function resolveZcodeLaunch(cli: string, env: Record<string, string | undefined> = process.env): ZcodeLaunch {
  const executable = zcodeExecutable(cli);
  const direct = (file: string): ZcodeLaunch =>
    NODE_SCRIPT.test(file) ? viaNode(file) : { command: file, args: [], env: {} };

  if (isAbsolute(executable)) return direct(executable);
  const onPath = findCliCandidates(executable)[0];
  if (onPath) return direct(onPath);
  if (executable === "zcode") {
    const bundled = zcodeBundlePaths(env).find((path) => existsSync(path));
    if (bundled) return viaNode(bundled);
  }
  // Not found: hand the name back so the spawn reports its own ENOENT.
  return { command: executable, args: [], env: {} };
}

export const EMPTY_ZCODE_CATALOG: ModelCatalog = { default: "", options: [] };

export function zcodeEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, PATH: augmentedPath() };
  // ZCode keeps its providers in its own config and login store. An inherited
  // provider key would silently flip billing onto one the user never granted
  // it, and workspace credentials are the harness's secrets, not zcode's.
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return env;
}

/** `provider/model` composite ids, split at the FIRST slash: provider ids are
 * colon-and-dash names (`account:bigmodel-individual-coding-plan`) and model
 * ids never contain one. */
export function splitZcodeModel(id: string): { providerId: string; modelId: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { providerId: id.slice(0, at), modelId: id.slice(at + 1) };
}

/** The turn's MCP servers in the shape `session/create` takes. The shared
 * builder is what the ACP family uses, so tool scope, custom-server gates and
 * the person's own servers behave the same; ZCode wants env as name/value
 * pairs and starts a script proxy through Electron-as-node. */
export function zcodeMcpServers(turn: SendTurnInput): Array<Record<string, unknown>> {
  const nodeEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  type Pairs = Array<{ name: string; value: string }>;
  const pairs = (env: Record<string, string> | Pairs | undefined): Pairs =>
    Array.isArray(env) ? env : Object.entries(env ?? {}).map(([name, value]) => ({ name, value }));
  const mount = (name: string, server: { command: string; args: string[]; env?: Record<string, string> | Pairs }) => {
    // acpMcpServers already hands env over as pairs; the phone integration is
    // still a record. ZCode takes pairs either way.
    const env = new Map(pairs(server.env).map((pair) => [pair.name, pair.value]));
    for (const [key, value] of Object.entries(nodeEnv)) env.set(key, value);
    return { name, command: server.command, args: server.args, env: [...env].map(([key, value]) => ({ name: key, value })) };
  };
  const servers: Array<Record<string, unknown>> = acpMcpServers(turn, { engine: ZCODE_DRIVER_KIND }).map((server) =>
    "type" in server
      ? { type: server.type, name: server.name, url: server.url, headers: server.headers }
      : mount(server.name, server),
  );
  // Not in the ACP set: the physical phone and the dweb daemon still mount here.
  if (turn.integrations?.phone) servers.push(mount("phone", turn.integrations.phone));
  if (turn.integrations?.dweb) servers.push({ type: "http", name: "dweb", url: turn.integrations.dweb.url, headers: [] });
  return servers;
}

/** What makes a mount set "different": which servers and how they start, not
 * the credentials in their env. Turn-scoped tokens and generation ids rotate
 * every turn; hashing them would rebuild the session (and lose the native
 * conversation) on every message. */
export function zcodeMcpKey(servers: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    servers.map((server) =>
      "type" in server
        ? { type: server.type, name: server.name, url: server.url }
        : { name: server.name, command: server.command, args: server.args },
    ),
  );
}

export interface ZcodeSession {
  sessionId: string;
  /** MCP mounts this session was created with; a changed turn recreates it. */
  mcpKey: string;
  /** model key last pinned on this session, so an unchanged turn skips the RPC */
  modelKey: string | null;
  mode: string | null;
  subscribed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface ZcodeTurn {
  threadId: string;
  turnId: string;
  settled: boolean;
  assistantText: string;
}

export interface ZcodeServerEvent {
  type?: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
}

/** One line-framed app-server child. The protocol is bidirectional: we send
 * `{id, method, params}` and answer the child's own `{id, method, params}`.
 * `pending` tracks only our requests; server requests are answered inline in
 * `handleFrame` because their replies must be written immediately. */
export interface ZcodeClient {
  readonly child: ReturnType<typeof spawnCli>;
  send(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  write(result: unknown, id: unknown): void;
}

/**
 * Spawn the app-server and wire its frames to `onFrame`. The caller owns
 * lifecycle: this returns the client, and `close()` kills the tree.
 */
export function startZcodeClient(input: {
  executable: string;
  /** Fixed args before `app-server` (the script path when launched via node). */
  argsPrefix?: string[];
  env: Record<string, string | undefined>;
  onFrame: (frame: Record<string, any>) => void;
  onExit: (error: Error) => void;
  onLog?: (dir: "in" | "out", msg: unknown) => void;
}): { client: ZcodeClient; close: () => void } {
  const spawned = spawnCli(input.executable, [...(input.argsPrefix ?? []), "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env,
  });
  let buf = "";
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const failAll = (err: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };

  const client: ZcodeClient = {
    child: spawned,
    send(method, params, timeoutMs = 60_000) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`zcode ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        input.onLog?.("out", { id, method, params });
        spawned.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    write(result, id) {
      spawned.stdin.write(JSON.stringify({ id, result }) + "\n");
    },
  };

  const handle = (frame: Record<string, any>) => {
    const method = typeof frame.method === "string" ? frame.method : undefined;
    if (method) {
      input.onLog?.("in", { method, params: frame.params });
      input.onFrame(frame);
      return;
    }
    if (frame.id === undefined) return;
    const id = Number(frame.id);
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(new Error(String(frame.error.message ?? "zcode request failed")));
    else waiter.resolve(frame.result);
  };

  spawned.stdin.on("error", () => failAll(new Error("zcode app-server stdin closed")));
  spawned.stdout.setEncoding("utf8");
  spawned.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as Record<string, any>);
      } catch {
        /* skip non-JSON line */
      }
    }
  });
  spawned.on("error", (err) => {
    failAll(new Error(describeSpawnFailure(err as NodeJS.ErrnoException, input.executable).message));
  });
  spawned.on("close", () => {
    failAll(new Error("zcode app-server exited"));
    input.onExit(new Error("zcode app-server exited"));
  });

  return {
    client,
    close: () => {
      try {
        spawned.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        killCliTree(spawned);
      } catch {
        /* already gone */
      }
    },
  };
}

export const ZcodeDriver: ProviderDriver<ZcodeConfig> = {
  driverKind: ZCODE_DRIVER_KIND,
  metadata: { displayName: "ZCode", supportsMultipleInstances: true, access: "custom" },
  install: {
    // There is no published zcode package: the CLI lives inside ZCode.app and
    // is started through the app's own Electron runtime. This one-liner puts
    // a working `zcode` shim on the augmented PATH (no Node.js needed), which
    // is also what `cli: "zcode"` resolves to. macOS only — the bundle layout
    // on other platforms is not known, and a path can be set by hand.
    command: {
      darwin:
        `mkdir -p ~/.local/bin && printf '#!/bin/sh\\nELECTRON_RUN_AS_NODE=1 exec "/Applications/ZCode.app/Contents/MacOS/ZCode" "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" "$@"\\n' > ~/.local/bin/zcode && chmod +x ~/.local/bin/zcode && ~/.local/bin/zcode version`,
    },
    needsNode: false,
  },
  models: EMPTY_ZCODE_CATALOG,
  decodeConfig: decodeZcodeConfig,
  defaultConfig: () => decodeZcodeConfig({}),

  async create(input: DriverCreateInput<ZcodeConfig>): Promise<ProviderInstance> {
    const { instanceId } = input;
    const config = decodeZcodeConfig(input.config);
    const sourceEnv = { ...process.env, ...input.environment };
    const launch = resolveZcodeLaunch(config.cli, sourceEnv);
    const executable = launch.command;
    const environment = { ...zcodeEnvironment(sourceEnv), ...launch.env };
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => {
      for (const listener of Array.from(listeners)) listener(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: ZCODE_DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    /** thread whose turn is in flight; the native log is keyed by thread */
    let activeThreadHint: string | undefined;
    let client: ZcodeClient | null = null;
    let stopClient: (() => void) | null = null;
    const sessions = new Map<string, ZcodeSession>();
    const active = new Map<string, { turnId: string; stop: () => void }>();
    const sessionIdForThread = new Map<string, string>();
    const threadForSession = new Map<string, string>();
    const turnForSession = new Map<string, ZcodeTurn>();
    /** level each model requires when selected (some providers reject a
     * selection without one) */
    const modelLevels = new Map<string, string>();
    /** thread whose session create/resume is in flight. The server announces
     * the session id inside its preferences request, BEFORE the create
     * resolves, so that request is the only chance to answer it. */
    let creatingSessionFor: string | null = null;
    /** A throwaway session created only to read the model catalog, plus the
     * ids it announced. Its preferences request is answered like a real one,
     * then it is closed. */
    let creatingProbeSession = false;
    const probeSessionIds = new Set<string>();
    /** resolved the first time the child publishes its model catalog */
    const catalogWaiters = new Set<() => void>();
    let models: ModelCatalog = EMPTY_ZCODE_CATALOG;
    /** Background/delayed first catalog read; snapshot waits for it so the
     * very first instance list already carries the engine's models. */
    let startupModelRefresh: Promise<void> | null = null;
    /** Server→client permission asks still waiting for the harness. The answer
     * is one of the request's own `options[].response` objects, which is the
     * `{decision, reason?, permissionUpdates?}` shape ZCode validates. */
    const pendingPermissions = new Map<
      string,
      {
        threadId: string;
        turnId: string;
        serverRequestId: unknown;
        kind: "permission" | "question";
        options: Array<{ kind: string; name: string; response?: Record<string, unknown> }>;
        /** the model's own questions, when this is a question card */
        questions?: AskQuestion[];
        timer: ReturnType<typeof setTimeout>;
      }
    >();

    const native = (dir: "in" | "out", msg: unknown) => {
      if (!activeThreadHint) return;
      try {
        appendNative(activeThreadHint, { dir, source: "zcode.rpc", msg });
      } catch {
        /* native logging never fails a turn */
      }
    };

    const settleTurn = (turn: ZcodeTurn, ok: boolean, stopReason: string, usage?: { input: number; output: number }) => {
      if (turn.settled) return;
      turn.settled = true;
      // A turn that ends while an ask is open must answer it: the child's
      // tool call is blocked on that reply.
      for (const [requestId, pending] of Array.from(pendingPermissions.entries())) {
        if (pending.turnId !== turn.turnId) continue;
        pendingPermissions.delete(requestId);
        clearTimeout(pending.timer);
        client?.write({ decision: "deny", reason: "The turn ended before this request was answered." }, pending.serverRequestId);
      }
      if (turn.assistantText.trim()) {
        emit({ ...base(turn.threadId, turn.turnId), type: "item.completed", itemType: "assistant_text", text: turn.assistantText });
      }
      active.delete(turn.threadId);
      const sessionId = sessionIdForThread.get(turn.threadId);
      if (sessionId) turnForSession.delete(sessionId);
      emit({
        ...base(turn.threadId, turn.turnId),
        type: "turn.completed",
        ok,
        stopReason,
        ...(usage ? { usage } : {}),
      });
    };

    /** Both a running session's `state.updated` patch and `session/create`'s
     * answer carry the same catalog shape; the create answer is what lets the
     * engine offer models before any turn (a bot cannot be moved onto an
     * engine that lists nothing). */
    const applyModelCatalog = (model: Record<string, any> | undefined) => {
      if (!model) return;
      const available = Array.isArray(model.available) ? (model.available as Array<Record<string, any>>) : [];
      const options: Array<{ id: string; label: string; custom: boolean; provider: string }> = [];
      for (const item of available) {
        const ref = item?.ref ?? {};
        if (typeof ref.providerId !== "string" || typeof ref.modelId !== "string") continue;
        const levels = item?.reasoning?.levels;
        const level =
          typeof item?.reasoning?.defaultLevel === "string"
            ? item.reasoning.defaultLevel
            : Array.isArray(levels) && typeof levels[0]?.value === "string"
              ? levels[0].value
              : undefined;
        const id = `${ref.providerId}/${ref.modelId}`;
        if (level) modelLevels.set(id, level);
        options.push({ id, label: String(item.label ?? ref.modelId), custom: true, provider: ref.providerId });
      }
      const current = model.current as { providerId?: string; modelId?: string } | undefined;
      const currentId =
        typeof current?.providerId === "string" && typeof current.modelId === "string"
          ? `${current.providerId}/${current.modelId}`
          : "";
      if (options.length) {
        models = { default: currentId || options[0].id, options };
        for (const waiter of Array.from(catalogWaiters)) {
          catalogWaiters.delete(waiter);
          waiter();
        }
      } else if (currentId) {
        models = { ...models, default: currentId };
      }
    };

    /** The catalog rides the session's first `state.updated` patch, so a turn
     * that must pin a model waits for it (briefly) instead of selecting a
     * model the provider then rejects for a missing reasoning level. */
    const waitForCatalog = (timeoutMs: number) =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          catalogWaiters.delete(done);
          resolve();
        };
        timer = setTimeout(done, timeoutMs);
        timer.unref?.();
        catalogWaiters.add(done);
      });

    const stopSession = (sessionId: string) => {
      void client?.send("session/stop", { sessionId }).catch(() => undefined);
    };

    const handleServerEvent = (event: ZcodeServerEvent) => {
      const sessionId = event.sessionId;
      if (!sessionId) return;
      if (!threadForSession.has(sessionId)) return;
      const turn = turnForSession.get(sessionId);
      const payload = event.payload ?? {};
      switch (event.type) {
        case "model.streaming": {
          if (!turn) return;
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (!delta) return;
          const kind = String(payload.kind ?? "text_delta");
          // The same channel also carries tool-input fragments, which are not
          // reply text: only the model's prose and reasoning are shown.
          const streamKind =
            kind === "text_delta" ? "assistant_text" : kind === "reasoning_delta" ? "reasoning_text" : null;
          if (!streamKind) return;
          if (streamKind === "assistant_text") turn.assistantText += delta;
          emit({ ...base(turn.threadId, turn.turnId), type: "content.delta", streamKind, delta });
          return;
        }
        case "tool.call.started":
        case "tool.started": {
          if (!turn) return;
          emit({
            ...base(turn.threadId, turn.turnId),
            type: "item.started",
            itemType: "tool",
            itemId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
            title: String(payload.toolName ?? payload.name ?? "tool").slice(0, 80),
            summary: typeof payload.detail === "string" ? payload.detail.slice(0, 200) : undefined,
          });
          return;
        }
        case "tool.call.completed":
        case "tool.call.failed": {
          if (!turn) return;
          emit({
            ...base(turn.threadId, turn.turnId),
            type: "item.completed",
            itemType: "tool",
            itemId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
            ok: event.type === "tool.call.completed",
          });
          return;
        }
        case "permission.requested":
          // Bookkeeping mirror of the `interaction/requestPermission` server
          // request, which is where the ask is actually answered. Nothing to
          // do here: the request handler owns the card and the reply.
          return;
        case "turn.completed": {
          if (!turn) return;
          const usage = payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          settleTurn(turn, true, "end_turn", usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined);
          return;
        }
        case "turn.failed": {
          if (!turn) return;
          emit({
            ...base(turn.threadId, turn.turnId),
            type: "runtime.error",
            message: String(payload.error ?? payload.message ?? "zcode turn failed").slice(0, 2_000),
          });
          settleTurn(turn, false, "failed");
          return;
        }
        default:
          return;
      }
    };

    const onFrame = (frame: Record<string, any>) => {
      const method = typeof frame.method === "string" ? frame.method : undefined;
      if (!method) return;
      if (method === "startup/storageState") return;
      if (ZCODE_ANSWERABLE_REQUESTS.has(method)) {
        const params = frame.params as { sessionId?: unknown } | undefined;
        const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
        if (!sessionId) return;
        // Only a session this driver opened (or is opening right now) gets an
        // answer; a request naming anything else is dropped, not relayed.
        if (!threadForSession.has(sessionId) && creatingSessionFor) {
          threadForSession.set(sessionId, creatingSessionFor);
          sessionIdForThread.set(creatingSessionFor, sessionId);
        }
        if (!threadForSession.has(sessionId) && creatingProbeSession) probeSessionIds.add(sessionId);
        if (threadForSession.has(sessionId) || probeSessionIds.has(sessionId)) {
          client?.write(ZCODE_RUNTIME_PREFERENCES, frame.id);
        }
        return;
      }
      if (method === "interaction/requestPermission") {
        const params = frame.params as {
          sessionId?: string;
          requestId?: string;
          toolName?: string;
          reason?: string;
          riskLevel?: string;
          options?: Array<{ kind?: string; name?: string; optionId?: string; response?: Record<string, unknown> }>;
        };
        const turn = params.sessionId ? turnForSession.get(params.sessionId) : undefined;
        const options = Array.isArray(params.options) ? params.options : [];
        if (!turn || !params.requestId || options.length === 0) {
          // Nothing to render an ask into: refuse rather than leave the child's
          // tool call blocked on a reply nobody will send.
          client?.write({ decision: "deny", reason: "No approval surface is available." }, frame.id);
          return;
        }
        const requestId = params.requestId;
        const timer = setTimeout(() => {
          if (!pendingPermissions.delete(requestId)) return;
          client?.write({ decision: "deny", reason: "Approval timed out." }, frame.id);
          emit({
            ...base(turn.threadId, turn.turnId),
            requestId,
            type: "request.resolved",
            behavior: "deny",
            source: "timeout",
          });
        }, 15 * 60_000);
        timer.unref?.();
        pendingPermissions.set(requestId, {
          threadId: turn.threadId,
          turnId: turn.turnId,
          serverRequestId: frame.id,
          kind: "permission",
          options: options.map((option) => ({
            kind: String(option.kind ?? "allow_once"),
            name: String(option.name ?? option.optionId ?? "Allow"),
            ...(option.response ? { response: option.response } : {}),
          })),
          timer,
        });
        emit({
          ...base(turn.threadId, turn.turnId),
          requestId,
          type: "request.opened",
          requestType: "permission",
          tool: String(params.toolName ?? "tool"),
          summary: String(params.reason ?? "This action needs approval").slice(0, 200),
            choices: options.map((option) => String(option.name ?? option.optionId ?? "Allow")),
          });
        return;
      }
      if (method === "interaction/requestUserInput") {
        // The model's own question (its AskUserQuestion path). Answered with
        // `{action:"accept", content:{answers}}`, never with a permission
        // decision.
        const params = frame.params as {
          sessionId?: string;
          requestId?: string;
          prompt?: string;
          toolName?: string;
          questions?: Array<{ question?: string; header?: string; multiSelect?: boolean; options?: unknown[] }>;
        };
        const turn = params.sessionId ? turnForSession.get(params.sessionId) : undefined;
        if (!turn || !params.requestId) {
          client?.write({ action: "decline" }, frame.id);
          return;
        }
        const requestId = params.requestId;
        const questions = parseAskQuestions({ questions: params.questions ?? [] }) ?? [];
        const prompt = String(params.prompt ?? questions[0]?.question ?? "The agent has a question").slice(0, 400);
        const timer = setTimeout(() => {
          if (!pendingPermissions.delete(requestId)) return;
          client?.write({ action: "decline" }, frame.id);
          emit({
            ...base(turn.threadId, turn.turnId),
            requestId,
            type: "request.resolved",
            behavior: "deny",
            source: "timeout",
          });
        }, 15 * 60_000);
        timer.unref?.();
        pendingPermissions.set(requestId, {
          threadId: turn.threadId,
          turnId: turn.turnId,
          serverRequestId: frame.id,
          kind: "question",
          options: [],
          questions,
          timer,
        });
        emit({
          ...base(turn.threadId, turn.turnId),
          requestId,
          type: "request.opened",
          requestType: "question",
          tool: String(params.toolName ?? "agent"),
          summary: prompt,
          ...(questions.length ? { questions } : {}),
          ...(questions[0]?.options.length ? { choices: questions[0].options.map((option) => option.label) } : {}),
        });
        return;
      }
      if (method === "state.updated") {
        const patch = (frame.params as { patch?: { model?: Record<string, any> } } | undefined)?.patch;
        applyModelCatalog(patch?.model);
        return;
      }
      if (method === "session/event") {
        handleServerEvent(frame.params as ZcodeServerEvent);
        return;
      }
      if (method === "session/lifecycle/changed") {
        const params = frame.params as { sessionId?: string; state?: string; lastError?: { message?: string } };
        if (!params.sessionId) return;
        const turn = turnForSession.get(params.sessionId);
        if (turn && !turn.settled && (params.state === "failed" || params.state === "unloaded")) {
          emit({
            ...base(turn.threadId, turn.turnId),
            type: "runtime.error",
            message: String(params.lastError?.message ?? "zcode session failed").slice(0, 2_000),
          });
          settleTurn(turn, false, "failed");
        }
      }
    };

    const forgetEverything = () => {
      client = null;
      stopClient = null;
      sessions.clear();
      sessionIdForThread.clear();
      threadForSession.clear();
      turnForSession.clear();
      active.clear();
    };

    const ensureClient = (): ZcodeClient => {
      if (client) return client;
      const started = startZcodeClient({
        executable,
        argsPrefix: launch.args,
        env: environment,
        onFrame,
        onExit: () => {
          for (const turn of Array.from(turnForSession.values())) {
            if (!turn.settled) settleTurn(turn, false, "failed");
          }
          forgetEverything();
        },
        onLog: native,
      });
      client = started.client;
      stopClient = started.close;
      return client;
    };

    /** Read the catalog without waiting for a person's turn. `session/create`
     * answers with the same model block a running session patches in, so one
     * throwaway session in the app's own data directory is enough; it is closed
     * right away, and the startup catalog helper caches the result. */
    let catalogProbe: Promise<void> | null = null;
    const refreshModels = async (): Promise<void> => {
      if (models.options.length) return;
      if (catalogProbe) return catalogProbe;
      const probe = (async () => {
        const workspace = join(DATA_DIR, "providers", "zcode-catalog");
        creatingProbeSession = true;
        try {
          const live = ensureClient();
          try {
            mkdirSync(workspace, { recursive: true });
          } catch {
            /* best effort: ZCode may still accept the path */
          }
          const created = (await live.send(
            "session/create",
            { workspace: { workspacePath: workspace, workspaceKey: workspace } },
            // The answer is immediate when the CLI works; do not hold startup
            // on a child that never replies.
            15_000,
          )) as { settings?: { model?: Record<string, any> } } | undefined;
          applyModelCatalog(created?.settings?.model);
          for (const sessionId of Array.from(probeSessionIds)) {
            void live.send("session/close", { sessionId }).catch(() => undefined);
          }
        } catch {
          // The engine still runs; the next Refresh (or start) tries again.
        } finally {
          creatingProbeSession = false;
          probeSessionIds.clear();
        }
      })();
      catalogProbe = probe.finally(() => {
        catalogProbe = null;
      });
      return catalogProbe;
    };

    const closeSession = (threadId: string) => {
      const session = sessions.get(threadId);
      if (!session) return;
      sessions.delete(threadId);
      sessionIdForThread.delete(threadId);
      threadForSession.delete(session.sessionId);
      turnForSession.delete(session.sessionId);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      void client?.send("session/close", { sessionId: session.sessionId }).catch(() => undefined);
    };

    /** Create or resume the session backing this thread. */
    const ensureSession = async (turnInput: SendTurnInput, threadId: string): Promise<ZcodeSession> => {
      const live = ensureClient();
      const mcpServers = zcodeMcpServers(turnInput);
      const mcpKey = zcodeMcpKey(mcpServers);
      const existing = sessions.get(threadId);
      // A live session keeps the mounts it was created with. A turn whose
      // tools changed (a bot switched a connector on, a scope narrowed) must
      // start a session that mounts the new set, not keep the old one.
      if (existing && !turnInput.sessionReset && existing.mcpKey === mcpKey) return existing;
      if (existing) closeSession(threadId);
      const cwd = turnInput.cwd ?? process.env.HOME ?? "/";
      const resumeId = typeof turnInput.resumeCursor === "string" ? turnInput.resumeCursor : null;
      creatingSessionFor = threadId;
      const mounts = mcpServers.length ? { mcpServers } : {};
      let result: { sessionId?: string; projection?: { sessionId?: string } } | undefined;
      try {
        result = (resumeId
          ? await live.send("session/resume", { sessionId: resumeId, ...mounts })
          : await live.send("session/create", { workspace: { workspacePath: cwd, workspaceKey: cwd }, ...mounts })) as
          | { sessionId?: string; projection?: { sessionId?: string } }
          | undefined;
      } finally {
        creatingSessionFor = null;
      }
      // The preferences request carries the real id; create/resume answers with
      // the projection (whose sessionId can still read "unknown").
      const announced = sessionIdForThread.get(threadId);
      const sessionId = announced ?? result?.sessionId ?? result?.projection?.sessionId;
      if (!sessionId || sessionId === "unknown") throw new Error("zcode did not return a session id");
      const session: ZcodeSession = { sessionId, mcpKey, modelKey: null, mode: null, subscribed: false, idleTimer: null };
      sessions.set(threadId, session);
      sessionIdForThread.set(threadId, sessionId);
      threadForSession.set(sessionId, threadId);
      return session;
    };

    const sendTurn = async (turnInput: SendTurnInput): Promise<{ turnId: string }> => {
      const { threadId } = turnInput;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const fullAuto = turnInput.approvalMode === undefined ? config.fullAuto : turnInput.approvalMode === "full";
      const turnId = newId();
      activeThreadHint = threadId;
      const session = await ensureSession(turnInput, threadId);
      const live = client;
      if (!live) throw new Error("zcode app-server is not running");

      // Full access runs unattended; every other policy keeps ZCode's own
      // approval mode so its asks reach the harness, which answers them.
      const desiredMode = fullAuto ? "yolo" : "build";
      if (session.mode !== desiredMode) {
        await live.send("session/setMode", { sessionId: session.sessionId, mode: desiredMode });
        session.mode = desiredMode;
      }
      const model = turnInput.model;
      if (model && session.modelKey !== model) {
        const split = splitZcodeModel(model);
        if (split) {
          if (!modelLevels.has(model)) await waitForCatalog(2_000);
          const select = (reasoningLevel?: string) =>
            live.send("session/setModel", {
              sessionId: session.sessionId,
              model: {
                providerId: split.providerId,
                modelId: split.modelId,
                ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
              },
            });
          try {
            await select(modelLevels.get(model));
          } catch (err) {
            // The catalog only lists what the child has materialized; a model
            // outside it still needs a level, and the provider is the one that
            // knows which. Retry once at the highest level it commonly accepts.
            if (!/reasoning level/i.test(String((err as Error)?.message ?? ""))) throw err;
            await select(modelLevels.get(model) ?? "max");
          }
          session.modelKey = model;
        }
      }
      if (!session.subscribed) {
        await live.send("session/subscribe", { sessionId: session.sessionId, deliveryKind: "desktop-continuous" });
        session.subscribed = true;
      }

      const state: ZcodeTurn = { threadId, turnId, settled: false, assistantText: "" };
      turnForSession.set(session.sessionId, state);
      active.set(threadId, {
        turnId,
        stop: () => {
          stopSession(session.sessionId);
          settleTurn(state, true, "cancelled");
        },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: session.sessionId, model: model ?? null });

      // ZCode's wire attachment is the composer's own shape (`kind` +
      // `localPath` + `dataBase64`), not the resolved `{type, path}` one: the
      // app-server normalizes this form, reads the file, resizes it (20 MB cap)
      // and inlines it as a model image block. Sending the resolved shape is
      // silently dropped as an unknown attachment.
      const attachments = (turnInput.images ?? []).map((image) => ({
        kind: "image",
        localPath: image.path,
        filename: basename(image.path),
        mimeType: image.mime,
        sizeBytes: image.bytes,
      }));
      const accepted = (await live.send("session/send", {
        sessionId: session.sessionId,
        content: turnInput.system ? `${turnInput.system}\n\n${turnInput.text}` : turnInput.text,
        ...(attachments.length ? { attachments } : {}),
      })) as { accepted?: boolean } | undefined;
      if (accepted && accepted.accepted === false) {
        settleTurn(state, false, "failed");
        throw new Error("zcode refused the prompt");
      }
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      // A cached catalog answers at once; when it is stale the read is
      // deferred, and the first instance list should already offer models.
      if (startupModelRefresh) await startupModelRefresh;
      const version = await new Promise<string | null>((resolve) => {
        try {
          execCli(executable, [...launch.args, "version"], { env: environment, timeout: 8_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
            resolve(error ? null : String(stdout).trim() || null);
          });
        } catch {
          resolve(null);
        }
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found (the ZCode desktop app ships it)` };
      // ZCode manages its own login (~/.zcode); there is no separate sign-in
      // step the harness can probe, so treat it as authed.
      return { state: "available", version, authenticated: true };
    };

    // A bot cannot be moved onto an engine that lists no models, and ZCode
    // only publishes its list from a session. Read/cache it at start (and on
    // Refresh) so the picker has something to offer before the first turn.
    const startupCatalog = await openStartupModelCatalog({
      instanceId,
      use: (saved) => {
        models = saved;
      },
      current: () => models,
      refresh: refreshModels,
    });
    startupModelRefresh = startupCatalog?.pending ?? null;

    return {
      instanceId,
      driverKind: ZCODE_DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      ...(startupModelRefresh ? { startupModelRefresh } : {}),
      snapshot,
      adapter: {
        provider: ZCODE_DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          // Mounted per session through session/create's mcpServers, from the
          // same shared builder the ACP family uses.
          agentsMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          dataMcp: true,
          emailMcp: true,
          deviceMcp: true,
          customMcp: true,
          // Images ride session/send's attachments; the prompt text carries no
          // attachment placeholder, so the harness must strip it.
          images: true,
          nativeImageInput: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => {
          active.get(threadId)?.stop();
        },
        respondToRequest: async (_threadId, requestId, decision) => {
          const pending = pendingPermissions.get(requestId);
          if (!pending) return "unavailable";
          pendingPermissions.delete(requestId);
          clearTimeout(pending.timer);

          if (pending.kind === "question") {
            const answers = questionAnswersByQuestion(decision.message ?? "", pending.questions ?? []);
            const content: Record<string, unknown> = {};
            for (const question of pending.questions ?? []) {
              const answer = answers[question.question];
              if (answer) content.answers = { ...(content.answers as object | undefined), [question.question]: answer };
            }
            const typed = (decision.message ?? "").trim();
            const accepted =
              decision.behavior === "answer" && (Object.keys(content).length > 0 || typed.length > 0);
            // Single free-text asks carry their answer directly; a picked
            // option is still echoed as an answer map so the model can read
            // which row the person chose.
            const body = accepted
              ? Object.keys(content).length > 0
                ? content
                : { answer: typed }
              : null;
            client?.write(body ? { action: "accept", content: body } : { action: "decline" }, pending.serverRequestId);
            emit({
              ...base(pending.threadId, pending.turnId),
              requestId,
              type: "request.resolved",
              behavior: body ? "answer" : "deny",
              source: "user",
            });
            return body ? "answered" : "rejected";
          }

          // The child validates the answer against the option list it sent, so
          // reply with the selected option's own response object.
          const pick = (kinds: string[]) => pending.options.find((option) => kinds.includes(option.kind));
          const chosen =
            decision.behavior === "deny"
              ? (pick(["deny"]) ?? pending.options.at(-1))
              : (pick(["allow_once"]) ?? pick(["allow_always"]) ?? pending.options[0]);
          const response =
            chosen?.response ??
            (decision.behavior === "deny"
              ? { decision: "deny", reason: decision.message || "The user denied this action." }
              : { decision: "allow", reason: "Approved once" });
          client?.write(response, pending.serverRequestId);
          emit({
            ...base(pending.threadId, pending.turnId),
            requestId,
            type: "request.resolved",
            behavior: decision.behavior,
            source: "user",
          });
          return decision.behavior === "deny" ? "rejected" : "allowed-once";
        },
        steer: async () => "refused",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of Array.from(active.values())) stop();
          for (const threadId of Array.from(sessions.keys())) closeSession(threadId);
        },
        onEvent: (listener: RuntimeEventListener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of Array.from(active.values())) stop();
        for (const threadId of Array.from(sessions.keys())) closeSession(threadId);
        stopClient?.();
        forgetEverything();
        listeners.clear();
      },
    };
  },
};




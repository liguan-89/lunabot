import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { isLoopback } from "../provider-key-check.ts";
import { jevRequestBody, parseJevResponse, questionsFit, refusal } from "./jev.ts";
import type { BackendRequest, BackendResult, DeciderBackend, DeciderQuestion } from "./types.ts";

export const LAYA_DEFAULT_MODEL = "aac6fef/laya-multilingual-coreml";
export const LAYA_MODEL_REVISION = "8139e9089273319512c730218903784074133187";
export const UV_VERSION = "0.11.8";
export const UV_ARCHIVE_SHA256 = "c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8";
export const UV_BINARY_SHA256 = "51f0ae3c531a124727fa39e16e8599f2e371e427822a4aa92ebf667b52548b43";
export const LAYA_SOURCE_COMMIT = "0d87482afaa9d2bc26dd84082ae6f56c98c5462a";

const UV_ASSET = "uv-aarch64-apple-darwin.tar.gz";
const MAX_UV_BYTES = 50 * 1024 * 1024;
const MODEL_LOAD_TIMEOUT_MS = 20 * 60_000;
const STOP_TIMEOUT_MS = 5_000;
const INSTALL_MARKER = "install.json";

export function localLayaSupported(platform: string = process.platform, arch: string = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

export function localLayaPaths(dataDir: string, projectDir: string) {
  const root = join(dataDir, "local-laya");
  return {
    root,
    uv: join(root, "bin", `uv-${UV_VERSION}`),
    uvDir: join(root, "bin"),
    uvCache: join(root, "uv-cache"),
    pythonDir: join(root, "python"),
    venv: join(root, "venv"),
    modelCache: join(root, "models"),
    logFile: join(root, "server.log"),
    project: projectDir,
  };
}

export function layaEndpoint(baseUrl?: string | null): URL | null {
  let url: URL;
  try {
    const root = (baseUrl?.trim() || "").replace(/\/+$/, "");
    url = new URL(`${root}/v1/systemone`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.protocol !== "http:" || !isLoopback(url.hostname)) return null;
  return url;
}

export function layaRequestBody(state: unknown, questions: Record<string, DeciderQuestion>) {
  return jevRequestBody(state, questions);
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const endpoint = layaEndpoint(request.baseUrl);
  if (!endpoint || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(layaRequestBody(request.state, request.questions)),
      signal: request.signal,
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return refusal(response.status);
  }
  try {
    const parsed = parseJevResponse(await response.json(), request.questions);
    return parsed.ok ? parsed : { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export const layaBackend: DeciderBackend = { id: "laya", decide };

export interface LocalLayaStatus {
  available: boolean;
  installed: boolean;
  running: boolean;
  busy: boolean;
  error: string | null;
  progress: string | null;
  model: string;
}

export interface LocalLayaService {
  status(): LocalLayaStatus;
  installed(): boolean;
  start(signal?: AbortSignal): Promise<LocalLayaStatus>;
  test(): Promise<{ ok: true } | { ok: false; reason: string }>;
  verified(): boolean;
  stop(): Promise<LocalLayaStatus>;
  credential(): { baseUrl: string; key: string } | null;
  supported: boolean;
}

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const UV_BINARY_VERSION = `uv ${UV_VERSION} (0e961dd9a 2026-04-27 aarch64-apple-darwin)`;
const INSTALL_FINGERPRINT = sha256(Buffer.from(`${LAYA_SOURCE_COMMIT}\n${UV_VERSION}\n${LAYA_DEFAULT_MODEL}\n${LAYA_MODEL_REVISION}`));

async function downloadUv(signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET}`, { redirect: "follow", signal });
  let host = "";
  try { host = new URL(response.url).hostname; } catch {}
  if (!response.ok || host !== "release-assets.githubusercontent.com") {
    await response.body?.cancel().catch(() => {});
    throw new Error(`uv download failed (${response.status || "redirect refused"}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("uv download returned no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_UV_BYTES) throw new Error("uv archive exceeded its size limit.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function runProcess(file: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  output?: (text: string) => void;
  signal?: AbortSignal;
} = {}): Promise<{ output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    let finished = false;
    let stopReason: string | null = null;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ output: tail });
    };
    const terminate = (message: string) => {
      if (stopReason) return;
      stopReason = message;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref?.();
      child.once("exit", () => clearTimeout(force));
    };
    const abort = () => terminate("Local model setup cancelled.");
    const append = (chunk: Uint8Array) => {
      const text = String(chunk);
      tail = `${tail}${text}`.slice(-3_000);
      options.output?.(text);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (stopReason) return finish(new Error(stopReason));
      finish(code === 0 ? undefined : new Error(tail.trim().slice(-500) || `Process exited (${code ?? signal}).`));
    });
    const timer = setTimeout(() => terminate("Local model setup timed out."), options.timeoutMs ?? 20 * 60_000);
    timer.unref?.();
  });
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForModel(port: number, child: ChildProcess, signal?: AbortSignal, startupError?: () => string) {
  const deadline = Date.now() + MODEL_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Local model setup cancelled.");
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = startupError?.();
      throw new Error(detail ? `The local model service exited during startup: ${detail}` : "The local model service exited during startup.");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json().catch((): unknown => null);
      const health = body && typeof body === "object" ? body as { status?: unknown; model?: unknown } : null;
      if (response.ok && health?.status === "ok" && health.model === LAYA_DEFAULT_MODEL) return;
    } catch {}
    await delay(500, undefined, { signal }).catch(() => {
      if (signal?.aborted) throw new Error("Local model setup cancelled.");
    });
  }
  throw new Error("The local model did not finish loading within 20 minutes.");
}

export function createLocalLaya(options: {
  dataDir: string;
  projectDir: string;
  enabled?: boolean;
  platform?: string;
  arch?: string;
  onState?: (state: LocalLayaStatus) => void;
}): LocalLayaService {
  const supported = options.enabled !== false && localLayaSupported(options.platform, options.arch);
  const paths = localLayaPaths(options.dataDir, options.projectDir);
  const pythonDir = join(paths.pythonDir, "bin");
  const runtimePython = join(pythonDir, "python3.12");
  const venvPython = join(paths.venv, "bin", "python");
  const markerPath = join(paths.root, INSTALL_MARKER);
  let processChild: ChildProcess | null = null;
  let port: number | undefined;
  let token: string | undefined;
  let childStderr = "";
  let operation: Promise<LocalLayaStatus> | null = null;
  let operationController: AbortController | null = null;
  let verified = false;
  let state: LocalLayaStatus = {
    available: supported,
    installed: false,
    running: false,
    busy: false,
    error: null,
    progress: null,
    model: LAYA_DEFAULT_MODEL,
  };
  let stopping = false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { fingerprint?: string };
    state.installed = marker.fingerprint === INSTALL_FINGERPRINT && existsSync(venvPython);
  } catch {}

  const publish = (patch: Partial<LocalLayaStatus>) => {
    state = { ...state, ...patch };
    try { options.onState?.({ ...state }); } catch {}
  };
  const status = () => ({ ...state });
  const installed = () => state.installed;
  const isVerified = () => verified && state.running && Boolean(credential());
  const credential = () => state.running && port && token ? { baseUrl: `http://127.0.0.1:${port}`, key: token } : null;
  const envForTools = () => ({
    HOME: paths.root,
    PATH: `${paths.uvDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG || "en_US.UTF-8",
    UV_CACHE_DIR: paths.uvCache,
    UV_PROJECT_ENVIRONMENT: paths.venv,
    UV_PYTHON_INSTALL_DIR: paths.pythonDir,
    UV_PYTHON_DOWNLOADS: "automatic",
  });
  const appendProgress = (text: string) => {
    const lower = text.toLowerCase();
    const progress = lower.includes("installing python") ? "Installing Python runtime…"
      : lower.includes("resolved") || lower.includes("prepared") || lower.includes("installed") ? "Preparing model dependencies…"
        : lower.includes("download") ? "Downloading the local model…"
          : lower.includes("lock") ? "Preparing the local environment…"
            : "Setting up the local model…";
    publish({ progress });
  };

  async function ensureUv(signal?: AbortSignal) {
    const valid = await readFile(paths.uv).then(async (binary) => {
      if (sha256(binary) !== UV_BINARY_SHA256) return false;
      try {
        const result = await runProcess(paths.uv, ["--version"], { timeoutMs: 5_000, signal });
        return result.output.trim() === UV_BINARY_VERSION;
      } catch { return false; }
    }).catch(() => false);
    if (valid) return;
    const archive = await downloadUv(signal);
    if (sha256(archive) !== UV_ARCHIVE_SHA256) throw new Error("uv release archive failed SHA-256 verification.");
    const scratch = await mkdtemp(join(paths.root, ".uv-"));
    const archivePath = join(scratch, UV_ASSET);
    try {
      await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
      await runProcess("/usr/bin/tar", ["-xzf", archivePath, "-C", scratch, "--no-same-owner", "--no-same-permissions"], { timeoutMs: 30_000, signal });
      const candidate = join(scratch, "uv-aarch64-apple-darwin", "uv");
      const binary = await readFile(candidate);
      if (sha256(binary) !== UV_BINARY_SHA256) throw new Error("uv executable failed SHA-256 verification.");
      await chmod(candidate, 0o700);
      await rename(candidate, paths.uv);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function install(signal?: AbortSignal) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await chmod(paths.root, 0o700);
    await mkdir(paths.uvDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.uvCache, { recursive: true, mode: 0o700 });
    await mkdir(paths.pythonDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.modelCache, { recursive: true, mode: 0o700 });
    await ensureUv(signal);
    const env = envForTools();
    if (!existsSync(runtimePython)) {
      await runProcess(paths.uv, ["python", "install", "3.12.11", "--install-dir", paths.pythonDir], { env, timeoutMs: 10 * 60_000, output: appendProgress, signal });
    }
    const interpreter = (await runProcess(paths.uv, ["python", "find", "3.12.11", "--no-project", "--managed-python"], {
      env: { ...env, UV_PYTHON_INSTALL_DIR: paths.pythonDir }, timeoutMs: 15_000, signal,
    })).output.trim().split(/\r?\n/).slice(-1)[0];
    if (!interpreter || !interpreter.startsWith(paths.pythonDir)) throw new Error("The private Python 3.12 runtime could not be verified.");
    if (!existsSync(venvPython)) {
      await runProcess(paths.uv, ["venv", "--python", interpreter, paths.venv], { env, timeoutMs: 60_000, output: appendProgress, signal });
    }
    await runProcess(paths.uv, ["sync", "--locked", "--project", paths.project, "--python", venvPython], { env, timeoutMs: 20 * 60_000, output: appendProgress, signal });
    await runProcess(venvPython, ["-c", "import laya_jev_api"], { env, timeoutMs: 15_000, signal });
    await writeFile(markerPath, JSON.stringify({ fingerprint: INSTALL_FINGERPRINT }), { mode: 0o600 });
    state.installed = true;
    publish({ installed: true, progress: null });
  }

  async function start(signal?: AbortSignal) {
    if (!supported) throw new Error("Local Laya requires Luna Bot on macOS with Apple Silicon.");
    if (state.running && processChild) return status();
    if (operation) return operation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    operationController = controller;
    operation = (async () => {
      publish({ busy: true, error: null, progress: "Preparing the local model environment…" });
      let started: ChildProcess | null = null;
      try {
        if (!installed()) await install(controller.signal);
        else await ensureUv(controller.signal);
        const nextPort = await unusedLoopbackPort();
        const nextToken = randomBytes(32).toString("base64url");
        childStderr = "";
        const serverEnv: NodeJS.ProcessEnv = {
          HOME: paths.root,
          PATH: `${join(paths.venv, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
          LANG: process.env.LANG || "en_US.UTF-8",
          HF_HOME: paths.modelCache,
          HF_HUB_CACHE: join(paths.modelCache, "hub"),
          TRANSFORMERS_CACHE: join(paths.modelCache, "transformers"),
          LJ_API_KEY: nextToken,
          LJ_MODEL: LAYA_DEFAULT_MODEL,
          LJ_MODEL_REVISION: LAYA_MODEL_REVISION,
          LJ_COMPUTE_UNITS: "cpu_gpu",
          LJ_HOST: "127.0.0.1",
          LJ_PORT: String(nextPort),
        };
        started = spawn(venvPython, ["-m", "laya_jev_api"], { cwd: paths.root, env: serverEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        started.stderr?.on("data", (chunk: Uint8Array) => { childStderr = `${childStderr}${String(chunk)}`.slice(-4_000); });
        processChild = started;
        started.once("exit", () => {
          if (processChild !== started || stopping) return;
          processChild = null;
          port = undefined;
          token = undefined;
          verified = false;
          publish({ running: false, busy: false, error: "The local model service stopped.", progress: null });
        });
        await waitForModel(nextPort, started, controller.signal, () => childStderr.trim().slice(-1_000));
        port = nextPort;
        token = nextToken;
        publish({ available: true, installed: true, running: true, busy: false, error: null, progress: null });
        return status();
      } catch (error) {
        stopping = true;
        started?.kill("SIGTERM");
        if (started) await Promise.race([once(started, "exit"), delay(STOP_TIMEOUT_MS)]);
        stopping = false;
        if (processChild === started) processChild = null;
        port = undefined;
        token = undefined;
        const message = error instanceof Error ? error.message : String(error);
        publish({ running: false, busy: false, error: message.slice(0, 500), progress: null });
        throw new Error(message.slice(0, 500));
      } finally {
        signal?.removeEventListener("abort", abort);
        operation = null;
        operationController = null;
      }
    })();
    return operation;
  }

  async function test(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const current = credential();
    if (!current) return { ok: false, reason: "not_running" };
    verified = false;
    const serviceQuestions: Record<string, DeciderQuestion> = {
      route: { type: "choice", instructions: "Select the option that matches the input.", options: { a: "The input says apple.", b: "The input says pear." } },
      level: { type: "score", instructions: "Score how clearly the input names a fruit.", levels: ["unclear", "somewhat clear", "clear"] },
      fruit: { type: "yesno", instructions: "Does the input mention apple?" },
    };
    try {
      const response = await fetch(`${current.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${current.key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(jevRequestBody("apple", serviceQuestions)),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, reason: `http_${response.status}` };
      }
      const parsed = parseJevResponse(await response.json(), serviceQuestions);
      if (!parsed.ok) return { ok: false, reason: "malformed" };
      verified = true;
      return { ok: true };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  async function stop() {
    operationController?.abort();
    const pending = operation;
    if (pending) await pending.catch(() => {});
    stopping = true;
    const current = processChild;
    processChild = null;
    current?.kill("SIGTERM");
    if (current) await Promise.race([once(current, "exit"), delay(STOP_TIMEOUT_MS)]);
    port = undefined;
    token = undefined;
    verified = false;
    stopping = false;
    publish({ running: false, busy: false, error: null, progress: null });
    return status();
  }

  return { status, installed, start, test, verified: isVerified, stop, credential, supported };
}

// A fake `docker` on LUNABOT_EXTRA_PATH stands in for the VPS (the server runs in its own process): argv in, canned inspect JSON out, every call logged.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { VPS_CONTAINER_LABEL, VPS_IMAGE, VPS_MANAGED_LABEL, VPS_VIEWER_LABEL, vpsContainerName } from "./vps-computer.ts";
import { CONTROL_BUSY } from "./control-client.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import type { RoutineSchedule } from "../shared/routines.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const PORT = workerPort(18800, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
/** Shortened, but past the 2 s after which the bridges' old control client told the model a person had taken control. */
const CALL_WAIT_MS = 3_000;

// the fake docker is a POSIX shell script, like every process fixture here
const posixOnly = describe.skipIf(process.platform === "win32");

function imageInspectJson(): string {
  return JSON.stringify([
    {
      Id: IMAGE_ID,
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** The fake docker substitutes __NAME__ from the inspect argv: the container name derives from a runtime bot id. */
function containerInspectTemplate(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Name: "/__NAME__",
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Env: ["VNC_PW=test-viewer-secret"],
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [VPS_VIEWER_LABEL]: "1",
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
      Mounts: [],
      HostConfig: {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    },
  ]);
}

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
server=$(printf '%s' "$2" | sed 's|ssh://||')
if [ -f "$FAKE_DOCKER_DIR/unreachable.$server" ]; then echo "ssh: Could not resolve hostname $server: nodename nor servname provided, or not known" >&2; exit 255; fi
if [ -f "$FAKE_DOCKER_DIR/hold" ]; then
  : > "$FAKE_DOCKER_DIR/started"
  while [ -f "$FAKE_DOCKER_DIR/hold" ]; do sleep 0.05; done
fi
case "$*" in
  *" run "*) rm -f "$FAKE_DOCKER_DIR/container-missing" ;;
  *" start "*) sed 's/"Running":false/"Running":true/' "$FAKE_DOCKER_DIR/container.json.tpl" > "$FAKE_DOCKER_DIR/container.next"; mv "$FAKE_DOCKER_DIR/container.next" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" container ls "*)
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/inventory-empty" ]; then :;
    elif [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then echo "${CONTAINER_ID}";
    elif ls "$FAKE_DOCKER_DIR"/container.name.* >/dev/null 2>&1; then :;
    else echo "${CONTAINER_ID}"; fi ;;
  *" container inspect "*)
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then name=$(cat "$FAKE_DOCKER_DIR/container.name.$alias"); else name=$(cat "$FAKE_DOCKER_DIR/container.name"); fi
    sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" image inspect "*)
    if [ -f "$FAKE_DOCKER_DIR/fail-inspect-once" ]; then
      rm "$FAKE_DOCKER_DIR/fail-inspect-once"
      echo "ssh: connection reset by peer" >&2
      exit 1
    fi
    cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*)
    : > "$FAKE_DOCKER_DIR/capture-started"
    while [ -f "$FAKE_DOCKER_DIR/hold-capture" ]; do sleep 0.05; done
    if [ -f "$FAKE_DOCKER_DIR/fail-capture" ]; then echo "fixture capture failed" >&2; exit 1; fi
    echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"scrot"*) echo "captured" ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" rm -f "*) : ;;
  *" inspect "*)
    if [ -f "$FAKE_DOCKER_DIR/container-missing" ]; then echo "No such container" >&2; exit 1; fi
    for arg in "$@"; do name="$arg"; done
    alias=$(printf '%s' "$2" | sed 's|ssh://||')
    if [ -f "$FAKE_DOCKER_DIR/container.name.$alias" ]; then printf '%s' "$name" > "$FAKE_DOCKER_DIR/container.name.$alias"; else printf '%s' "$name" > "$FAKE_DOCKER_DIR/container.name"; fi
    sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

posixOnly("VPS turn routing e2e (fake pi fleet + fake docker over SSH)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let gateFile: string;
  // The fake pi's launch log: launch rows carry the mounted MCP servers, prompt rows the whole prompt.
  let piDump: string;
  let dockerLog: string;

  type ApiBody = Record<string, string | boolean | null | RoutineSchedule | { instanceId: string; model: string } | { sshAlias: string }>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  /** The MCP servers of the latest pi launch, in the shape the ACP fixture's mcp dump had. */
  const mountedServers = (): Array<{ name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> }> => {
    const rows = readFileSync(piDump, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const launch = rows.filter((row: any) => row.argv).at(-1);
    const servers = (launch?.mcpConfig?.mcpServers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    return Object.entries(servers).map(([name, spec]) => ({ name, command: spec.command, args: spec.args,
      env: Object.entries(spec.env ?? {}).map(([entryName, value]) => ({ name: entryName, value })) }));
  };

  /** One computer tools/call exactly as the harness proxy forwards it, without exposing the SSH alias to the agent. */
  const computerCall = async (server: { env?: Array<{ name: string; value: string }> }, name: string, args: Record<string, unknown> = {}) => {
    const env = (key: string) => server.env?.find((entry) => entry.name === key)?.value ?? "";
    const res = await fetch(`${env("LUNABOT_HARNESS_URL")}/api/internal/computer/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${env("LUNABOT_MCP_TOKEN_COMPUTER")}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: res.status, body: await res.json() as any };
  };

  /** Every prompt a pi process was given, whole (system halves and the turn's own words together). */
  const promptRows = (): string[] => {
    try {
      return readFileSync(piDump, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row: any) => row.prompt)
        .map((row: any) => String(row.prompt.message ?? ""));
    } catch {
      return [];
    }
  };

  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_PI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-vps-routing-"));
    mkdirSync(join(home, ".lunabot"), { recursive: true });
    const fakeBin = join(home, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    gateFile = join(home, "turn.gate");
    piDump = join(home, "pi.dump.jsonl");
    dockerLog = join(fakeBin, "docker.log");

    writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    chmodSync(join(fakeBin, "docker"), 0o755);
    // Only the viewer's local listening socket is simulated; no SSH network or real VPS is contacted.
    writeFileSync(join(fakeBin, "ssh"), `#!${process.execPath}
import { createServer } from 'node:net';
const args = process.argv.slice(2);
if (!args.includes('-L')) process.exit(0);
const forward = args[args.indexOf('-L') + 1];
const port = Number(forward.split(':')[1]);
createServer(socket => socket.end()).listen(port, '127.0.0.1');
`, { mode: 0o755 });
    writeFileSync(join(fakeBin, "image.json"), imageInspectJson());
    writeFileSync(join(fakeBin, "container.json.tpl"), containerInspectTemplate());
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600),
      Buffer.from("IEND", "ascii"),
    ]);
    writeFileSync(join(fakeBin, "screenshot.b64"), png.toString("base64"));
    writeFileSync(dockerLog, "");

    writeFileSync(
      join(home, ".lunabot", "config.json"),
      JSON.stringify({
        instances: {
          pi: {
            driver: "piAgent",
            environment: {
              // Slow turns hold until the gate file exists, then reply with the turn's own words.
              FAKE_PI_MODE: "slow",
              FAKE_PI_SLOW_FINISH_GATE: gateFile,
              FAKE_PI_DUMP: piDump,
              // Mount the turn's MCP servers at boot, so a scoped turn's tool-scope receipt is written.
              FAKE_PI_MOUNT_TOOLS: "1",
            },
            config: { cli: FAKE_PI },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      LUNABOT_PORT: String(PORT),
      LUNABOT_EXTRA_PATH: fakeBin,
      FAKE_DOCKER_DIR: fakeBin,
      FAKE_DOCKER_LOG: dockerLog,
      LUNABOT_COMPUTER_CALL_WAIT_MS: String(CALL_WAIT_MS),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("recovers a transient VPS inspection failure through the real status route without provisioning", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    const marker = join(dirname(dockerLog), "fail-inspect-once");
    const offset = readFileSync(dockerLog, "utf8").length;
    writeFileSync(marker, "fail once");
    try {
      const result = await api("GET", `/api/bots/${bot.id}/computer`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ backend: "vps", ready: true, container: "running" });
      const calls = readFileSync(dockerLog, "utf8").slice(offset);
      expect(calls.match(/ image inspect /g)).toHaveLength(2);
      expect(calls).not.toMatch(/ssh:\/\/production-vps (run|start|stop|rm|pull|build) /);
    } finally { rmSync(marker, { force: true }); }
  });

  it.each([
    {
      settings: "customized resources and operator restart",
      computer: "cloud" as const,
      hostConfig: {
        Memory: 8 * 1024 * 1024 * 1024, MemorySwap: 16 * 1024 * 1024 * 1024,
        NanoCpus: 3_000_000_000, PidsLimit: 1024, ShmSize: 1024 * 1024 * 1024,
        OomKillDisable: true, RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
      },
    },
    {
      settings: "unlimited resources and legacy restart no",
      computer: null,
      hostConfig: {
        Memory: 0, MemorySwap: -1, NanoCpus: 0, PidsLimit: 0, ShmSize: 64 * 1024 * 1024,
        OomKillDisable: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      },
    },
  ])("reuses the existing VPS with $settings through status and turn routing", async ({ computer, hostConfig }) => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots")).body.bot;
    const template = join(dirname(dockerLog), "container.json.tpl");
    const original = readFileSync(template, "utf8");
    const container = JSON.parse(original);
    Object.assign(container[0].HostConfig, hostConfig);
    const configured = JSON.stringify(container);
    writeFileSync(template, configured);
    writeFileSync(gateFile, "open");
    rmSync(piDump, { force: true });
    const offset = readFileSync(dockerLog, "utf8").length;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        computer, modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" },
      })).status).toBe(200);
      const status = await api("GET", `/api/bots/${bot.id}/computer`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ backend: "vps", ready: true, security: "hardened", container: "running" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use the existing VPS desktop" })).status).toBe(202);
      await until(async () => {
        const saved = await botById(bot.id);
        return !saved.busy && saved.messages.some((message: any) => message.text?.startsWith("reply to: "));
      }, "the turn on the customized VPS");
      const mounted = mountedServers();
      expect(mounted.find((tool: any) => tool.name === "computer"), "computer capability reached the agent").toBeTruthy();
      const calls = readFileSync(dockerLog, "utf8").slice(offset);
      expect(calls).not.toMatch(/ssh:\/\/production-vps (run|start|stop|rm|pull|build|update) /);
      expect(readFileSync(template, "utf8")).toBe(configured);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      writeFileSync(template, original);
    }
  }, 30_000);

  it("shares a canceled preview with retries and opens control without racing destructive actions", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    const fixtureDir = dirname(dockerLog);
    const hold = join(fixtureDir, "hold-capture");
    const started = join(fixtureDir, "capture-started");
    const failed = join(fixtureDir, "fail-capture");
    const captures = () => readFileSync(dockerLog, "utf8").split("\n").filter(line => line.includes("--screenshot-out-file")).length;
    const path = `/api/bots/${bot.id}/computer`;
    let retries: Array<Promise<{ status: number; body: any }>> = [];
    try {
      writeFileSync(hold, "hold");
      rmSync(started, { force: true });
      const before = captures();
      const cancel = new AbortController();
      const first = fetch(`${BASE}${path}/screenshot`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: cancel.signal,
      });
      await until(async () => existsSync(started), "the pending preview");
      cancel.abort();
      await expect(first).rejects.toThrow();
      retries = [api("POST", `${path}/screenshot`, {}), api("POST", `${path}/screenshot`, {})];

      for (const action of ["provision", "sleep", "remove"]) {
        const blocked = await api("POST", `${path}/${action}`, {});
        expect(blocked.status, action).toBe(409);
        expect(blocked.body.error).toMatch(/preview.*refreshing/);
      }
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } })).status).toBe(409);

      expect((await api("POST", `${path}/control`, { action: "take" })).status).toBe(200);
      const joined = await api("POST", `${path}/join`, {});
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body.joinUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html#/);
      expect(captures() - before).toBe(1);
      rmSync(hold, { force: true });
      for (const result of await Promise.all(retries)) {
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ format: "png", png: expect.any(String) });
      }
      expect(captures() - before).toBe(1);

      writeFileSync(failed, "fail");
      const failure = await api("POST", `${path}/screenshot`, {});
      expect(failure.status).toBe(500);
      expect(failure.body.error).toMatch(/fixture capture failed/);
      rmSync(failed, { force: true });
      expect((await api("POST", `${path}/screenshot`, {})).status).toBe(200);
    } finally {
      rmSync(hold, { force: true });
      rmSync(failed, { force: true });
      await Promise.allSettled(retries);
      await api("POST", `${path}/viewer-close`, {});
      await api("POST", `${path}/control`, { action: "release" });
    }
  }, 30_000);

  it("starts a cloud turn after a slow preview without reporting preparation failure", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, {
      computer: "cloud" as const, modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" },
    });
    const fixtureDir = dirname(dockerLog);
    const hold = join(fixtureDir, "hold-capture");
    const started = join(fixtureDir, "capture-started");
    writeFileSync(gateFile, "open");
    rmSync(piDump, { force: true });
    rmSync(started, { force: true });
    writeFileSync(hold, "hold");
    const preview = api("POST", `/api/bots/${bot.id}/computer/screenshot`, {});
    try {
      await until(async () => existsSync(started), "the slow preview");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Check the VPS after its screen refresh" })).status).toBe(202);
      await until(async () => (await botById(bot.id))?.busy === true, "turn setup waiting on the preview");
      // Deliberately past the old 5 s acquisition deadline: a normal screen refresh must not end the turn.
      await new Promise(resolve => setTimeout(resolve, 6_000));
      const waiting = await botById(bot.id);
      expect(waiting.busy, JSON.stringify(waiting.messages)).toBe(true);
      expect(JSON.stringify(waiting.messages)).not.toContain("the VPS is being prepared");
      rmSync(hold, { force: true });
      expect((await preview).status).toBe(200);
      await until(async () => {
        const saved = await botById(bot.id);
        return !saved.busy && saved.messages.some((message: any) => message.text?.startsWith("reply to: "));
      }, "the recovered VPS turn");
      const mounted = mountedServers();
      expect(mounted.find((tool: any) => tool.name === "computer"), "computer capability reached the agent").toBeTruthy();
    } finally {
      rmSync(hold, { force: true });
      await preview;
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    }
  }, 30_000);

  it.each(["stopped", "missing"])(
    "lets Auto discover a %s VPS and start or create it through its chat tool",
    async state => {
      await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
      const bot = (await api("POST", "/api/bots")).body.bot;
      const template = join(dirname(dockerLog), "container.json.tpl");
      const missing = join(dirname(dockerLog), "container-missing");
      const original = readFileSync(template, "utf8");
      try {
        if (state === "stopped") writeFileSync(template, original.replace('"Running":true', '"Running":false'));
        else if (state === "missing") writeFileSync(missing, "missing");
        writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
        rmSync(gateFile, { force: true }); rmSync(piDump, { force: true });
        await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: null,
          modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } });
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the available remote VM" })).status).toBe(202);
        await until(async () => existsSync(piDump), "the discovery turn");
        const first = mountedServers();
        expect(first.find((tool: { name: string }) => tool.name === "computer")).toBeUndefined();
        const agents = first.find((tool: { name: string }) => tool.name === "agents");
        const token = agents!.env!.find((entry) => entry.name === "LUNABOT_COMMS_TOKEN")!.value;
        const availability = await (await fetch(`${BASE}/api/internal/computer/select`, { headers: { authorization: `Bearer ${token}` } })).json() as any;
        expect(availability.options.find((option: any) => option.surface === "cloud")).toMatchObject({ available: true, ready: false,
          canStart: state !== "missing", canCreate: state === "missing" });
        const selected = await fetch(`${BASE}/api/internal/computer/select`, { method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "auto" }) });
        expect(await selected.json()).toMatchObject({ status: "pending", surface: "cloud" });
        rmSync(piDump, { force: true });
        const before = readFileSync(dockerLog, "utf8").length;
        writeFileSync(gateFile, "open");
        await until(async () => existsSync(piDump) && !(await botById(bot.id))?.busy, "the switched VPS turn");
        const next = mountedServers();
        expect(next.find((tool: { name: string }) => tool.name === "computer"), "computer capability reached the agent").toBeTruthy();
        const commands = readFileSync(dockerLog, "utf8").slice(before);
        expect(commands).toContain(state === "missing" ? " run " : " start ");
        expect(commands).not.toMatch(/ssh:\/\/production-vps (?:pull|build) /);
        if (state !== "missing") expect(commands).not.toContain(" run ");
        const saved = await botById(bot.id);
        expect(saved.messages.filter((message: { role: string; kind: string }) => message.role === "user" && message.kind === "text")).toHaveLength(1);
      } finally {
        writeFileSync(gateFile, "open");
        await api("POST", `/api/bots/${bot.id}/interrupt`, {});
        rmSync(missing, { force: true });
        writeFileSync(template, original);
      }
    },
    45_000,
  );

  it("restarts a VPS that stops after Auto mounted it, on the first real screen call", async () => {
    await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
    const bot = (await api("POST", "/api/bots")).body.bot;
    const template = join(dirname(dockerLog), "container.json.tpl");
    const original = readFileSync(template, "utf8");
    writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
    rmSync(gateFile, { force: true });
    rmSync(piDump, { force: true });
    try {
      await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: null,
        modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the available remote VM" })).status).toBe(202);
      await until(async () => existsSync(piDump), "the Auto turn with the running VPS");
      const computer = mountedServers().find((tool) => tool.name === "computer");
      expect(computer, "a running VPS is reused by Auto").toBeTruthy();

      writeFileSync(template, original.replace('"Running":true', '"Running":false'));
      const before = readFileSync(dockerLog, "utf8").length;
      const shot = await computerCall(computer!, "screenshot");
      expect(shot.status, JSON.stringify(shot.body)).toBe(200);
      expect(shot.body.result?.isError, JSON.stringify(shot.body)).not.toBe(true);
      const commands = readFileSync(dockerLog, "utf8").slice(before);
      expect(commands).toContain(" start ");
      expect(commands).not.toContain(" run ");

      writeFileSync(gateFile, "open");
      await until(async () => !(await botById(bot.id))?.busy, "the Auto turn settling");
      const saved = await botById(bot.id);
      expect(saved.messages.filter((message: { role: string; kind: string }) => message.role === "user" && message.kind === "text")).toHaveLength(1);
    } finally {
      writeFileSync(gateFile, "open");
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      writeFileSync(template, original);
    }
  }, 30_000);

  it(
    "mounts the VPS computer on the turn, tells the model, reuses without provisioning, and clears the claim",
    async () => {
      writeFileSync(dockerLog, "");
      rmSync(gateFile, { force: true });
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);

      const bot = (await api("POST", "/api/bots")).body.bot;
      writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
      await api("PATCH", `/api/bots/${bot.id}`, {
        name: "Remote hand",
        modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" },
      });
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);

      const fixtureDir = dirname(dockerLog);
      writeFileSync(join(fixtureDir, "hold"), "hold");
      rmSync(join(fixtureDir, "started"), { force: true });
      const provisioning = api("POST", `/api/bots/${bot.id}/computer/provision`, {});
      await until(async () => {
        try {
          readFileSync(join(fixtureDir, "started"));
          return true;
        } catch {
          return false;
        }
      }, "the held VPS lifecycle call");
      const lifecycleRace = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(lifecycleRace.status).toBe(409);
      expect(lifecycleRace.body.error).toMatch(/cloud computer actions|VPS computer actions/i);
      rmSync(join(fixtureDir, "hold"), { force: true });
      expect((await provisioning).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);

      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "check the remote desktop" });
      expect(sent.status).toBe(202);
      await until(async () => (await botById(bot.id))?.busy === true, "the gated turn");

      const aliasChange = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(aliasChange.status).toBe(409);
      expect(aliasChange.body.error).toMatch(/active bot work|active VPS turn/i);

      writeFileSync(gateFile, "open");
      let snapshot: any;
      await until(async () => {
        snapshot = await botById(bot.id);
        return (
          snapshot?.busy === false &&
          snapshot.messages.some((m: any) => m.kind === "text" && m.text?.startsWith("reply to: "))
        );
      }, "the echoed turn");

      // What the model was told: the turn's whole prompt, as the fake pi recorded it.
      const told = promptRows().at(-1)!;
      expect(told).toContain("self-hosted remote Linux computer");
      expect(told).toContain("This is the user's own VPS");
      expect(told).toContain("wiped whenever its container is recreated");

      // SAFETY: the fake pi wrote this launch row from its boot MCP config; fake-pi-cli.ts pins the shape.
      const mcpServers = mountedServers() as Array<{
        name: string;
        command: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      }>;
      const computer = mcpServers.find((s) => s.name === "computer");
      expect(computer, "no computer MCP server reached the agent").toBeTruthy();
      // The harness proxy deliberately keeps the SSH alias and container id server-side.
      expect(computer?.env?.some((entry) => entry.name === "LUNABOT_HARNESS_URL")).toBe(true);
      expect(computer?.env?.some((entry) => entry.name === "LUNABOT_MCP_TOKEN_COMPUTER")).toBe(true);

      // The Local VM boot probe also hits the fake docker, without -H.
      const invocations = readFileSync(dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("-H ssh://"));
      expect(invocations.length).toBeGreaterThan(0);
      for (const line of invocations) {
        const command = line.split(" ")[2];
        expect(["image", "inspect", "exec", "version"], line).toContain(command);
      }

      const status = await api("GET", `/api/bots/${bot.id}/computer`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ backend: "vps", ready: true, container: "running" });

      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const explicitThread = (await api("POST", `/api/bots/${bot.id}/tasks`, {})).body.task.threadId;
      rmSync(piDump, { force: true });
      const cloudTurn = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: explicitThread, text: "Open Chrome on the VPS and inspect the page" });
      expect(cloudTurn.status, JSON.stringify(cloudTurn.body)).toBe(202);
      await until(async () => existsSync(piDump) && (await botById(bot.id))?.busy === false, "the explicit VPS turn");
      const explicitTools = mountedServers();
      expect(explicitTools.find((tool: { name: string }) => tool.name === "computer"), "computer capability reached the agent").toBeTruthy();
      const threadPreview = await api("GET", `/api/bots/${bot.id}/computer?threadId=${explicitThread}`);
      expect(threadPreview.body).toMatchObject({ surface: "cloud", backend: "vps", ready: true });

      const created = await api("POST", "/api/routines", {
        botId: bot.id, name: "VPS scheduled check", prompt: "Check the existing VPS.", enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.routine.runOn).toBe("maus");
      rmSync(piDump, { force: true });
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      let completed: any;
      await until(async () => {
        completed = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === started.body.run.id);
        return completed?.status === "completed";
      }, "the routine on the existing VPS");
      const routineTools = mountedServers();
      expect(routineTools.find((tool: { name: string }) => tool.name === "computer"), "computer capability reached the agent").toBeTruthy();
      // What the model was told on the routine's turn: the VPS is named as the user's own computer.
      const routineTold = promptRows().filter((text) => text.includes("Check the existing VPS.")).at(-1)!;
      expect(routineTold).toContain("This is the user's own VPS");

      const released = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(released.status, JSON.stringify(released.body)).toBe(409);
      expect(released.body.error).toMatch(/remove.*VPS computers/i);

      writeFileSync(join(fixtureDir, "inventory-empty"), "empty");
      writeFileSync(join(fixtureDir, "hold"), "hold");
      rmSync(join(fixtureDir, "started"), { force: true });
      const changing = api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      await until(async () => {
        try {
          readFileSync(join(fixtureDir, "started"));
          return true;
        } catch {
          return false;
        }
      }, "the held VPS alias validation");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "do not cross hosts" })).status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/computer/provision`, {})).status).toBe(409);
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
      rmSync(join(fixtureDir, "hold"), { force: true });
      expect((await changing).status).toBe(200);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    },
    60_000,
  );

  it(
    "runs two turns of one bot on the VPS at once; the desktop is claimed by the first computer call and waited for by name",
    async () => {
      writeFileSync(dockerLog, "");
      rmSync(gateFile, { force: true });
      rmSync(piDump, { force: true });
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
      const bot = (await api("POST", "/api/bots")).body.bot;
      writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
      await api("PATCH", `/api/bots/${bot.id}`, { name: "TCPR operator", modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } });
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const mountedComputer = () => {
        const servers = mountedServers() as Array<{ name: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
        const computer = servers.find((server) => server.name === "computer");
        expect(computer, "no computer MCP server reached the agent").toBeTruthy();
        return { args: computer!.args ?? [], server: computer! };
      };
      const activities = async (threadId: string) =>
        ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[])
          .filter((m) => m.kind === "activity").map((m) => String(m.tool?.name ?? ""));
      const taskBusy = async (threadId: string) => Boolean((await botById(bot.id))?.tasks?.find((t: any) => t.threadId === threadId)?.busy);

      const refill = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "TCPR 3 hour capacity refill" })).body.task;
      const check = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Queue check" })).body.task;
      try {
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: refill.threadId, text: "Refill capacity on the VPS" })).status).toBe(202);
        await until(async () => existsSync(piDump) && await taskBusy(refill.threadId), "the long VPS turn");
        const refillMount = mountedComputer();
        rmSync(piDump, { force: true });

        expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: check.threadId, text: "Check the queue on the VPS" })).status).toBe(202);
        await until(async () => existsSync(piDump) && await taskBusy(check.threadId), "the second VPS turn, while the first still runs");
        const checkMount = mountedComputer();
        const harnessToken = (mount: { server: { env?: Array<{ name: string; value: string }> } }) =>
          mount.server.env?.find((entry) => entry.name === "LUNABOT_MCP_TOKEN_COMPUTER")?.value ?? "";
        expect(harnessToken(checkMount)).not.toBe("");
        expect(harnessToken(checkMount)).not.toBe(harnessToken(refillMount));
        expect(await taskBusy(refill.threadId)).toBe(true);
        expect((await activities(check.threadId)).join("|")).not.toContain("Waiting for its turn");
        expect((await activities(refill.threadId)).join("|")).not.toContain("Waiting for its turn");
        expect((await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } })).status).toBe(409);

        const first = await computerCall(checkMount.server, "screenshot");
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.result?.isError, JSON.stringify(first.body)).not.toBe(true);
        const started = Date.now();
        const contended = await computerCall(refillMount.server, "screenshot");
        expect(contended.status, JSON.stringify(contended.body)).toBe(200);
        expect(contended.body.result).toEqual({ isError: true, content: [{ type: "text", text: CONTROL_BUSY }] });
        expect(Date.now() - started).toBeGreaterThanOrEqual(CALL_WAIT_MS - 200);
        // The chip may add a queue position and an estimate; the holder it names is what is under test.
        const waitChip = /^Waiting for its turn on this computer(?: — \d+(?:st|nd|rd|th) in queue)? — TCPR operator is running Queue check\. Starts automatically when that finishes(?:; recent waits here have taken [^.]+)?\.$/;
        await until(async () => (await activities(refill.threadId)).some((name) => waitChip.test(name)), "the wait chip naming the holder");

        writeFileSync(gateFile, "open");
        await until(async () => (await botById(bot.id))?.busy === false, "both turns settling");
        const settled = await activities(refill.threadId);
        expect(settled.join("|")).not.toMatch(/still busy|error/i);
        expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
      } finally {
        writeFileSync(gateFile, "open");
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: refill.threadId });
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: check.threadId });
      }
    },
    60_000,
  );

  it("runs a teammate turn whose Auto VPS is unavailable, telling the model why instead of failing it", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const asker = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", browser: false, modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } });
    const teammate = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${teammate.id}`, { name: "VPS teammate", browser: false, computer: null,
      modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } });
    writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(teammate.id));
    const template = join(dirname(dockerLog), "container.json.tpl");
    const original = readFileSync(template, "utf8");
    writeFileSync(template, original.replace('"Running":true', '"Running":false'));
    rmSync(gateFile, { force: true });
    rmSync(piDump, { force: true });
    try {
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Ask your teammate for the queue summary" })).status).toBe(202);
      await until(async () => existsSync(piDump), "the asker's turn");
      const agents = mountedServers().find((server) => server.name === "agents");
      const token = agents?.env?.find((entry) => entry.name === "LUNABOT_COMMS_TOKEN")?.value ?? "";
      const sent = await fetch(`${BASE}/api/internal/coordinate-bots`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ botIds: [teammate.id], message: "Summarise the queue numbers from this morning." }),
      });
      const queued = await sent.json() as { receipts?: Array<{ threadId?: string }> };
      expect(sent.status, JSON.stringify(queued)).toBe(200);
      const workThread = queued.receipts?.[0]?.threadId ?? "";
      // Delegated work runs once the delegating turn settles, so the asker finishes here and the teammate runs.
      writeFileSync(gateFile, "open");
      const replies = async () => ((await api("GET", `/api/threads/${workThread}/messages?limit=100`)).body.messages as any[]) ?? [];
      await until(async () => (await replies()).some((message) =>
        message.text?.startsWith("reply to: ") || String(message.tool?.name ?? "").startsWith("error:")), "the teammate's turn");
      const thread = await replies();
      expect(thread.filter((message) => String(message.tool?.name ?? "").startsWith("error:"))).toEqual([]);
      // What the teammate's turn was told: the VPS is unavailable, with the way to enable it.
      const told = promptRows().filter((text) => text.includes("Summarise the queue numbers from this morning.")).at(-1)!;
      expect(told).toContain("This bot's VPS computer is unavailable this turn (The Luna Bot VPS container is stopped)");
      expect(told).toContain("Open Computer and enable Start VPS automatically");
    } finally {
      writeFileSync(template, original);
      await api("POST", `/api/bots/${asker.id}/interrupt`, {});
    }
  }, 45_000);

  it(
    "keeps each bot on its own SSH alias: per-bot routing, a merged inventory, and the move guards",
    async () => {
      writeFileSync(dockerLog, "");
      rmSync(join(dirname(dockerLog), "inventory-empty"), { force: true });
      writeFileSync(gateFile, "open");
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
      const alpha = (await api("POST", "/api/bots")).body.bot;
      const beta = (await api("POST", "/api/bots")).body.bot;
      const free = (await api("POST", "/api/bots")).body.bot;
      const alphaName = vpsContainerName(alpha.id);
      const betaName = vpsContainerName(beta.id);
      writeFileSync(join(dirname(dockerLog), "container.name.alpha-vps"), alphaName);
      writeFileSync(join(dirname(dockerLog), "container.name.production-vps"), betaName);

      expect((await api("PATCH", `/api/bots/${alpha.id}`, { vpsAlias: "alpha-vps" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${alpha.id}`, { computer: "cloud" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${beta.id}`, { computer: "cloud" })).status).toBe(200);
      expect((await botById(alpha.id)).vpsAlias).toBe("alpha-vps");
      expect((await botById(beta.id)).vpsAlias).toBeUndefined();

      // Each bot's status inspects the server it was pointed at.
      const alphaStatus = await api("GET", `/api/bots/${alpha.id}/computer`);
      expect(alphaStatus.status, JSON.stringify(alphaStatus.body)).toBe(200);
      expect(alphaStatus.body).toMatchObject({ backend: "vps", ready: true });
      const betaStatus = await api("GET", `/api/bots/${beta.id}/computer`);
      expect(betaStatus.status, JSON.stringify(betaStatus.body)).toBe(200);
      expect(betaStatus.body).toMatchObject({ backend: "vps", ready: true });
      const log = readFileSync(dockerLog, "utf8");
      expect(log).toMatch(/-H ssh:\/\/alpha-vps (?:container )?inspect /);
      expect(log).toMatch(/-H ssh:\/\/production-vps (?:container )?inspect /);

      // The preview and the panel's own actions go to the bot's server and never touch the default.
      const hosts = () => [...readFileSync(dockerLog, "utf8").matchAll(/-H ssh:\/\/([\w.-]+)/g)].map((match) => match[1]);
      writeFileSync(dockerLog, "");
      expect((await api("POST", `/api/bots/${alpha.id}/computer/screenshot`, {})).status).toBe(200);
      expect((await api("POST", `/api/bots/${alpha.id}/computer/provision`, {})).status).toBe(200);
      expect(hosts().length).toBeGreaterThan(0);
      expect(new Set(hosts())).toEqual(new Set(["alpha-vps"]));

      // The Settings inventory spans both servers and tags every computer with its alias.
      const inventory = await api("GET", "/api/computers/vps");
      expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
      expect(inventory.body.vpsAliases).toEqual(["production-vps", "alpha-vps"]);
      const alphaRow = (inventory.body.instances as any[]).find((row) => row.ownerBotId === alpha.id);
      const betaRow = (inventory.body.instances as any[]).find((row) => row.ownerBotId === beta.id);
      expect(alphaRow).toMatchObject({ vpsAlias: "alpha-vps", name: alphaName, state: "running" });
      expect(betaRow).toMatchObject({ vpsAlias: "production-vps", name: betaName, state: "running" });

      // The default server stays attached while a computer still lives on it.
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } })).status).toBe(409);

      // A live computer blocks its owner's move, even to clear the override.
      const blocked = await api("PATCH", `/api/bots/${alpha.id}`, { vpsAlias: "gamma-vps" });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/remove this bot's VPS computer/i);
      expect((await api("PATCH", `/api/bots/${alpha.id}`, { vpsAlias: null })).status).toBe(409);
      expect((await botById(alpha.id)).vpsAlias).toBe("alpha-vps");

      // A bot with no computer of its own chooses a server freely, then falls back to the default.
      expect((await api("PATCH", `/api/bots/${free.id}`, { vpsAlias: "gamma-vps" })).status).toBe(200);
      expect((await botById(free.id)).vpsAlias).toBe("gamma-vps");
      expect((await api("PATCH", `/api/bots/${free.id}`, { vpsAlias: null })).status).toBe(200);
      expect((await botById(free.id)).vpsAlias).toBeUndefined();
      expect((await api("PATCH", `/api/bots/${free.id}`, { vpsAlias: "bad alias!" })).status).toBe(400);

      // A real turn mounts the computer bridge against the bot's own server.
      expect((await api("PATCH", `/api/bots/${alpha.id}`, { browser: false, modelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } })).status).toBe(200);
      rmSync(piDump, { force: true });
      try {
        expect((await api("POST", `/api/bots/${alpha.id}/messages`, { text: "Check the desk on my own server" })).status).toBe(202);
        await until(async () => existsSync(piDump), "the alpha turn's computer mount");
        const servers = mountedServers();
        const computer = servers.find((server) => server.name === "computer");
        expect(computer, "no computer MCP server reached the agent").toBeTruthy();
        // The harness proxy deliberately keeps the SSH alias server-side.
        expect(computer!.args).not.toContain("alpha-vps");
        expect(computer!.args).not.toContain("production-vps");
      } finally {
        await api("POST", `/api/bots/${alpha.id}/interrupt`, {});
      }

      // Deleting the bot checks and removes its computer on its own server only.
      await until(async () => (await botById(alpha.id))?.busy === false, "the alpha turn to settle");
      writeFileSync(dockerLog, "");
      const deleted = await api("DELETE", `/api/bots/${alpha.id}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
      const deletion = readFileSync(dockerLog, "utf8");
      expect(deletion).toMatch(/-H ssh:\/\/alpha-vps rm -f /);
      expect(deletion).not.toContain("ssh://production-vps");
    },
    60_000,
  );

  it("never keeps a bot on a server that is gone: it moves off, switches computer and is deleted", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const leaving = (await api("POST", "/api/bots")).body.bot;
    const switching = (await api("POST", "/api/bots")).body.bot;
    for (const bot of [leaving, switching]) {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { vpsAlias: "gone-vps" })).status).toBe(200);
    }
    // The provider cancelled the server, or the alias left ~/.ssh/config: nothing answers for gone-vps any more.
    const gone = join(dirname(dockerLog), "unreachable.gone-vps");
    writeFileSync(gone, "");
    try {
      const moved = await api("PATCH", `/api/bots/${leaving.id}`, { vpsAlias: null });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body.bot.vpsAlias).toBeUndefined();
      expect(moved.body.notice).toContain("gone-vps could not be reached");
      expect(moved.body.notice).toContain(`docker -H ssh://gone-vps rm -f ${vpsContainerName(leaving.id)}`);

      const deleted = await api("DELETE", `/api/bots/${switching.id}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.notice).toContain("gone-vps could not be reached");
      expect(deleted.body.notice).toContain(vpsContainerName(switching.id));
      expect(await botById(switching.id)).toBeUndefined();
    } finally {
      rmSync(gone, { force: true });
      await api("DELETE", `/api/bots/${leaving.id}`);
    }
  }, 30_000);
});

// POSIX-gated like the other CLI e2es: the fake is a shebang script.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  role: string;
  kind: string;
  text?: string;
  compaction?: { summary: string };
  card?: { answered?: string; skillRequest?: { name: string } };
}
interface Row {
  botId: string;
  threadId: string;
  instanceId: string;
  driverKind: string;
  model: string;
  trigger: { kind: string; botId?: string; job?: string };
}

/** One isolated server in a throwaway home, with the fake pi and
 * whatever else the test puts in config.json. */
async function boot(extraConfig: Record<string, unknown>) {
  chmodSync(fake("fake-pi-cli.ts"), 0o755);
  const port = workerPort(18800, 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-helper-model-"));
  const dataDir = join(home, ".lunabot");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      pi: { driver: "piAgent", environment: { FAKE_PI_MODE: "tooluse" }, config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } },
    },
    memory: { captureQuietMs: 1_000 },
    ...extraConfig,
  }));
  let stderr = "";
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_DATA_DIR: dataDir };
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  let stdout = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // Generous on purpose: every wait ends the moment its condition holds, and
  // a busy machine starts each fake CLI slowly.
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const close = async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, "the server to come up");
  } catch (error) {
    // a server that never answered is still this test's to stop
    await close();
    throw error;
  }

  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === id) as { busy: boolean; messages: Msg[] };
  const newBot = async () => {
    const created = (await api("POST", "/api/bots", {})).body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
    return created;
  };
  /** One turn, sent and settled with its reply. */
  const turn = async (bot: { id: string }, text: string) => {
    const before = (await getBot(bot.id)).messages.filter((message) => message.role === "bot" && message.kind === "text").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.filter((message) => message.role === "bot" && message.kind === "text").length > before;
    }, `a turn of ${bot.id} to settle`);
  };
  const ledger = (botId: string): Row[] => {
    const file = join(dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row).filter((row) => row.botId === botId);
  };
  const memory = async (botId: string) => ((await api("GET", `/api/bots/${botId}/memory/file?path=MEMORY.md`)).body?.text ?? "") as string;
  const compacted = async (bot: { id: string; threadId: string }) => {
    expect((await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.some((message) => message.kind === "compaction");
    }, "the compaction record");
    return (await getBot(bot.id)).messages.find((message) => message.kind === "compaction")!.compaction!.summary;
  };
  return { api, waitFor, getBot, newBot, turn, ledger, memory, compacted, close, log: () => stdout, dataDir };
}

// The one connected engine, pi, has no one-off text call, so a helper that names it is stored but never used:
// every small writing job keeps its fallback, and the log says why instead of failing anything.
posixOnly("a helper that names the only connected engine, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    server = await boot({
      helper: { instanceId: "pi" },
      features: { skillReview: true, skillReviewSteps: 3 },
    });
  }, 90_000);
  afterAll(async () => { await server?.close(); });

  it("keeps every fallback — memory capture, skill review, the compaction summary — and says why", async () => {
    const { api, waitFor, getBot, newBot, turn, ledger, memory, compacted } = server;
    const bot = await newBot();
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: false });

    // one tool step a turn: three reach the review threshold
    for (const text of ["Just so you know, I'm vegetarian.", "Write the weekly report from the notes.", "Shorter please, five bullets at most."]) await turn(bot, text);

    await waitFor(async () => (await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body.lastCapture?.note === NO_TEXT_ENGINE, "the capture to be refused for want of an engine");
    expect(await memory(bot.id)).not.toContain("The person is vegetarian");
    await waitFor(() => server.log().includes(`skill review: ${bot.id}: this bot's engine cannot run a background review`), "the review to be refused");
    expect((await getBot(bot.id)).messages.some((message) => message.card?.skillRequest)).toBe(false);

    const summary = await compacted(bot);
    expect(summary).toMatch(/^Historical excerpts in chronological order/);

    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
    expect(ledger(bot.id)).toContainEqual(expect.objectContaining({ driverKind: "piAgent", threadId: bot.threadId, trigger: { kind: "owner" } }));
    expect(server.log()).toContain('helper model: the helper instance "pi" cannot make a one-off text call, so bots whose engine has no one-off text call keep their fallback');
  }, 300_000);

  it("stays config.json's own field: a settings request cannot name or clear it, and an unconnected instance reads as not connected", async () => {
    const { api, waitFor, newBot, dataDir } = server;
    const bot = await newBot();
    const file = join(dataDir, "config.json");
    const write = (change: (config: Record<string, unknown>) => void) => {
      const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      change(config);
      writeFileSync(file, JSON.stringify(config));
    };

    // The resolver says its answer once per change and only when a side job asks it; the tidy route is
    // the desktop's own "tidy now" and asks it at once. The upkeep tick would too, but it fires at 60 s
    // and every 10 min and skips every bot until the local hour reaches memory.tidyHour (default 3), so
    // a CI runner whose clock reads 00:xx UTC never asks within a test's wait.
    const tidy = async () => expect((await api("POST", `/api/bots/${bot.id}/memory/tidy`)).status).toBe(200);

    // A retry reuses this server (beforeAll runs once), so put the boot's own helper back and let the
    // resolver say so again: what follows then proves a fresh read of the file, not an earlier attempt's
    // leftover line or its leftover helper.
    write((config) => { config.helper = { instanceId: "pi" }; });
    await tidy();

    // alone it is nothing to save, and beside a real setting it is dropped while the file keeps its helper
    expect(await api("PATCH", "/api/config", { helper: { instanceId: "" } })).toMatchObject({ status: 400, body: { error: "nothing to save" } });
    expect((await api("PATCH", "/api/config", { helper: { instanceId: "" }, language: "en" })).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ helper: { instanceId: "pi" }, language: "en" });

    const said = server.log().length;
    write((config) => { config.helper = { instanceId: "missing" }; });
    await tidy();
    await waitFor(() => server.log().slice(said).includes('helper model: the helper instance "missing" is not connected, so bots whose engine has no one-off text call keep their fallback'),
      "the missing helper instance to be reported, not used", 30_000);
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body.modelSteps).toBe(false);

    // with the entry gone the fallback is the same honest one: excerpts, no helper calls
    write((config) => { delete config.helper; });
    const summary = await server.compacted(bot);
    expect(summary).toMatch(/^Historical excerpts in chronological order/);
    expect(server.ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
  }, 240_000);

  it("accepts a bot's never-use-the-helper switch, saves it, and refuses a wrong type", async () => {
    const { api, getBot, newBot, dataDir } = server;
    const bot = await newBot();

    for (const wrong of ["no", 0, null, { off: true }]) {
      const refused = await api("PATCH", `/api/bots/${bot.id}`, { helperModel: wrong });
      expect(refused.status, JSON.stringify(wrong)).toBe(400);
      expect(refused.body.error).toBe("helperModel must be true or false");
    }
    expect(await getBot(bot.id)).not.toHaveProperty("helperModel");

    const saved = await api("PATCH", `/api/bots/${bot.id}`, { helperModel: false });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ id: bot.id, helperModel: false });
    expect(await getBot(bot.id)).toMatchObject({ helperModel: false });
    const onDisk = () => existsSync(join(dataDir, "bots.json"))
      ? (JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Array<{ id: string; helperModel?: boolean }>).find((record) => record.id === bot.id)
      : undefined;
    await server.waitFor(async () => onDisk()?.helperModel === false, "the switch to land in bots.json");

    expect((await api("PATCH", `/api/bots/${bot.id}`, { helperModel: true })).status).toBe(200);
    await server.waitFor(async () => onDisk()?.helperModel === true, "the switch back to land in bots.json");
  }, 120_000);

  it("creates a bot already kept off the helper when the creation request says so, which is how a duplicate keeps its source's switch", async () => {
    const { api, getBot, dataDir } = server;
    // the body src/lib/bot-duplicate.ts builds for a source with helperModel: false
    const created = await api("POST", "/api/bots", { settings: { helperModel: false } });
    expect(created.status).toBe(201);
    expect(created.body.bot).toMatchObject({ helperModel: false });
    const id = created.body.bot.id as string;
    // before any later request: on the wire and in the saved record
    expect(await getBot(id)).toMatchObject({ helperModel: false });
    const onDisk = () => existsSync(join(dataDir, "bots.json"))
      ? (JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Array<{ id: string; helperModel?: boolean }>).find((record) => record.id === id)
      : undefined;
    await server.waitFor(async () => onDisk()?.helperModel === false, "the creation-time switch to land in bots.json");
    // the copy then takes its source's engine
    expect((await api("PATCH", `/api/bots/${id}`, { name: "Private copy", modelSelection: { instanceId: "pi", model: "fake-model" } })).status).toBe(200);
    expect((await api("GET", `/api/bots/${id}/memory/upkeep`)).body).toMatchObject({ modelSteps: false });
    expect((await api("POST", "/api/bots", { settings: { helperModel: "false" } })).status).toBe(400);
  }, 120_000);
});

posixOnly("without a helper model, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { server = await boot({}); }, 90_000);
  afterAll(async () => { await server?.close(); });

  it("keeps a Pi bot's fallbacks: no model steps for upkeep, and an excerpt summary", async () => {
    const { api, newBot, turn, ledger } = server;
    const bot = await newBot();
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: false });
    await turn(bot, "Just so you know, I'm vegetarian.");
    const summary = await server.compacted(bot);
    expect(summary).toMatch(/^Historical excerpts in chronological order/);
    expect(summary).not.toContain("Model-written");
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
    expect(server.log()).not.toContain("helper model:");
  }, 180_000);
});

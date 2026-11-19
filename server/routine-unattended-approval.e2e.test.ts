// A routine run that asks for an approval nobody is there to give: the real server and the synthetic pi, whose
// extension-UI confirm becomes the approval card, and the driver's own fifteen-minute deadline for an unanswered ask
// brought forward by a marker file. The engine asks; the test only writes the marker and reads what the run and the
// person's notifications say.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** The tool the fake pi's confirm names, so the card reads as the one the retired fixture's broker asked about. */
const TOOL = "COMPOSIO_SEARCH_TOOLS";

let home: string | undefined;
let server: ChildProcess | undefined;
let events: SseRecorder | undefined;
afterEach(async () => {
  events?.close();
  await waitForExit(server, { signal: "SIGTERM" });
  server = undefined;
  if (home) await removeTempDir(home);
  home = undefined;
});

it("waits for the person, tells them at once, and stops saying nobody answered the approval when it went unanswered", async () => {
  home = mkdtempSync(join(tmpdir(), "omb-routine-unattended-"));
  const dataDir = join(home, ".lunabot");
  mkdirSync(dataDir, { recursive: true });
  // The fixture's own TMPDIR (verificationServerEnvironment points it here) has to exist before the engine spawns.
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const expire = join(dataDir, "expire-approvals");
  // The fake pi asks through its own extension-UI confirm instead of replying: `confirm`, not `select`, so the server
  // reads a permission card, and the title names the tool the run waits on.
  const cli = join(home, "pi-asking.mjs");
  writeFileSync(cli, [
    "#!/usr/bin/env node",
    `process.env.FAKE_PI_PERMISSION_ON = ${JSON.stringify("Search my inbox")};`,
    `process.env.FAKE_PI_CONFIRM_TITLE = ${JSON.stringify(`Allow ${TOOL}?`)};`,
    `await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-pi-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { pi: {
    driver: "piAgent", displayName: "pi", config: { cli },
  } } }));
  // The pi driver's own unanswered-ask deadline (fifteen minutes) fires on a marker file instead, so a check need not
  // sit through it. Nothing else in that module's timers is touched.
  const clock = join(home, "ask-clock.mjs");
  writeFileSync(clock, `
import { registerHooks } from "node:module";
const marker = ${JSON.stringify(expire)};
const target = new URL("./drivers/pi.ts", ${JSON.stringify(pathToFileURL(SERVER_DIR).href)}).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    const source = String(result.source);
    const block = /timer = setTimeout\\(\\(\\) => \\{[\\s\\S]*?\\}, 15 \\* 60_000\\);/.exec(source);
    if (!block) throw new Error("The pi driver's unanswered-ask timer seam changed");
    const replacement = block[0]
      .replace("timer = setTimeout(() => {", "timer = setInterval(() => { if (!process.getBuiltinModule('node:fs').existsSync(" + JSON.stringify(marker) + ")) return; clearInterval(timer);")
      .replace("}, 15 * 60_000);", "}, 25);");
    return { ...result, source: source.replace(block[0], replacement) };
  },
});
`, { mode: 0o600 });

  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", pathToFileURL(clock).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: verificationServerEnvironment({ FAKE_PI_PERMISSION_ON: "Search my inbox" }, dataDir, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout?.on("data", (chunk) => { log += chunk; });
  server.stderr?.on("data", (chunk) => { log += chunk; });
  await expect.poll(async () => {
    try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true).catch((error) => { throw new Error(`${error.message}\n${log.slice(-3_000)}`); });

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}\n${log.slice(-2_000)}`).toBeLessThan(300);
    return value;
  };
  const bot = (await runControlOmb(["new-bot", "--name", "Inbox bot", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const { routine } = await api("POST", "/api/routines", {
    name: "Inbox brief", prompt: "Search my inbox and summarise it.", botId: bot.id, timeoutMinutes: 5,
    schedule: { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" },
  });
  events = await openSse(`${url}/api/events`, { origin: url });
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; title: string; body: string });
  const run = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);

  await api("POST", `/api/routines/${routine.id}/run`);
  // The run waits on the person the moment the engine asks, and the person hears at once.
  await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "waiting", attention: `Waiting for your approval to use ${TOOL}` });
  await expect.poll(notified, { timeout: hostTimeout(15_000) }).toContainEqual(expect.objectContaining({
    kind: "approval", title: "Inbox bot needs approval", body: `Inbox brief: Waiting for your approval to use ${TOOL}`,
  }));
  const waiting = await run();
  const chat = async () => (await api("GET", `/api/threads/${waiting.resultsThreadId ?? bot.threadId}/messages?limit=100`)).messages as any[];
  const copy = (await chat()).find((message: any) => message.automation?.runId === waiting.id && message.kind === "options");
  expect(copy).toMatchObject({ card: { tool: TOOL, requestType: "permission" }, automation: { needsYou: true } });

  // Nobody answers: the driver's own deadline passes.
  writeFileSync(expire, "");
  const stopped = `Stopped: nobody answered the approval to use ${TOOL}`;
  await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "failed", error: stopped });
  await expect.poll(notified, { timeout: hostTimeout(15_000) }).toContainEqual(expect.objectContaining({ kind: "routine-failed", body: `Inbox brief: ${stopped}` }));
  await expect.poll(async () => (await chat()).find((message) => message.id === copy.id)?.card?.answered, { timeout: hostTimeout(15_000) }).toBeTruthy();
  await expect.poll(async () => (await chat()).find((message) => message.automation?.runId === waiting.id && message.kind === "text")?.text, { timeout: hostTimeout(15_000) })
    .toBe(`This run didn't finish: ${stopped}`);
  await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id)?.busy, { timeout: hostTimeout(15_000) }).toBe(false);
}, hostTimeout(90_000));

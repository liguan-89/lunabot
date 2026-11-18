// Real server, one AI: pi. This build runs a single agent and the pi driver has no one-shot text call, so a test message
// cannot be sent at all: the AI's test is recorded as untestable, nothing moves (there is nothing to move to), a restart
// keeps that record, and a saved default is never tested. The "one miss, then the AI that answered" behaviour that needed
// two engines is covered by server/tested-ai.test.ts with stub engines.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_PI = join(ROOT, "server/testing/fake-pi-cli.ts");

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omb-tested-ai-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { pi: { driver: "piAgent", displayName: "Verification pi", config: { cli: FAKE_PI } } },
    ...extra,
  }));
  return home;
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    // Background test messages are off in test fixtures unless asked for.
    env: { ...verificationServerEnvironment(process.env, home, port), OMB_AI_CHECKS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  const tests = async () => Object.fromEntries(((await api("GET", "/api/instances")).instances as Array<{ instanceId: string; aiTest?: string }>)
    .filter((instance) => instance.instanceId === "pi")
    .map((instance) => [instance.instanceId, instance.aiTest ?? null]));
  const starter = async () => ((await api("GET", "/api/bots?messages=0")).bots as Array<{ chiefOfStaff?: boolean; modelSelection: { instanceId: string } }>)
    .find((bot) => bot.chiefOfStaff)!;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { api, tests, starter, stop };
}

it("records the one AI's test as untestable, moves nothing, and remembers that across a restart", async () => {
  const home = freshHome();
  const server = await boot(home);
  await expect.poll(server.tests, { timeout: 30_000, interval: 250 }).toEqual({ pi: "untestable" });
  // A check the person asks for reads the same: pi has no one-shot call to answer it.
  expect(await server.api("POST", "/api/instances/pi/check", {})).toEqual({ ok: null });
  expect((await server.starter()).modelSelection.instanceId).toBe("pi");
  const made = await server.api("POST", "/api/bots", { name: "Made after the test" });
  expect(made.bot.modelSelection.instanceId).toBe("pi");
  // A restart sends nothing and keeps the record.
  await server.stop();
  const again = await boot(home);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await again.tests()).toEqual({ pi: "untestable" });
  expect((await again.starter()).modelSelection.instanceId).toBe("pi");
}, 90_000);

it("never tests or moves a saved default", async () => {
  const server = await boot(freshHome({ defaultModelSelection: { instanceId: "pi", model: "ollama-cloud/glm-5.2" } }));
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(await server.tests()).toEqual({ pi: null });
  expect((await server.starter()).modelSelection.instanceId).toBe("pi");
}, 60_000);

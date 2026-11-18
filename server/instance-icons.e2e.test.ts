// Real server: the one instance this build runs (pi) shows the mark stored for it in the engine list, so every client
// shows it without asking again. The custom OpenAI-compatible provider is no longer an instance of its own: it lives in
// config.json's openaiCompat slot and pi's picker, so a server's host mark (server/provider-icon.ts) is covered by its
// unit tests rather than an instance the route would list.
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
const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

it("lists the pi engine with the mark stored for it, and refuses a mark that is not one of the presets", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-instance-icons-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    // The custom provider a person saves in Settings → API keys: not an engine, so never an instance here.
    openaiCompat: { key: "fixture-key", url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: verificationServerEnvironment(process.env, home, port), stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);

  const listed = async () => {
    const response = await fetch(`${base}/api/instances`, { headers: { origin: base } });
    expect(response.status).toBe(200);
    return (await response.json() as { instances: Array<{ instanceId: string; icon?: unknown }> }).instances;
  };
  const before = await listed();
  expect(before.map((instance) => instance.instanceId)).toEqual(["pi"]);
  expect(before[0]!.icon).toBeUndefined();

  const patched = await fetch(`${base}/api/instances/pi/icon`, {
    method: "PATCH", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ icon: { kind: "preset", preset: "cohere" } }),
  });
  expect(patched.status).toBe(200);
  const after = (await patched.json() as { instances: Array<{ instanceId: string; icon?: unknown }> }).instances;
  expect(after.find((instance) => instance.instanceId === "pi")!.icon).toEqual({ kind: "preset", preset: "cohere" });
  expect((await listed()).find((instance) => instance.instanceId === "pi")!.icon).toEqual({ kind: "preset", preset: "cohere" });

  const refused = await fetch(`${base}/api/instances/pi/icon`, {
    method: "PATCH", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ icon: { kind: "preset", preset: "not-a-mark" } }),
  });
  expect(refused.status).toBe(400);
  expect((await listed()).find((instance) => instance.instanceId === "pi")!.icon).toEqual({ kind: "preset", preset: "cohere" });
}, 60_000);

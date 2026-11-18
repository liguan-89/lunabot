// POSIX only: a Windows SIGTERM ends the process without its shutdown hooks.
// pi's driver has no one-shot text call, so no capture pass ever runs: the turn waiting at the stop is kept in the pending
// file, restored on the next start, and refused there with the reason upkeep gives (server/memory-upkeep.ts NO_TEXT_ENGINE)
// instead of reaching memory. This proves that whole round trip, which is what the file is for.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

it.skipIf(process.platform === "win32")("keeps a turn that was still waiting when the server stopped, and answers for it after the next start", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-capture-restart-"));
  const parentEnv = { ...process.env };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const pending = join(dataDir, "memory-capture-pending.json");
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Cellist" }, 201);
    // a quiet spell far longer than this test: the turn is still waiting at the stop
    await api("/api/config", "PUT", { memory: { captureQuietMs: 600_000 } });
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "I play the cello every Sunday morning.", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = readFileSync(pending, "utf8");
    expect(saved).toContain(bot.threadId);
    // The queue holds which turn to read again, never what was said in it.
    expect(saved).not.toContain("cello");

    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ ...config, memory: { ...config.memory, captureQuietMs: 1_000 } }, null, 2));
    restarted = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
      cwd: ROOT,
      env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)),
      stdio: "ignore",
    });
    await expect.poll(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, { timeout: 20_000, interval: 150 }).toBe(true);
    // upkeep starts once the engines are read, a moment after health answers; the restored turn reaches the capture
    // call, which this engine cannot make, and the status says so.
    await expect.poll(async () => (await api<{ lastCapture?: { note?: string } }>(`/api/bots/${bot.id}/memory/upkeep`)).lastCapture?.note ?? null,
      { timeout: 30_000 }).toBe(NO_TEXT_ENGINE);
    // The queue is consumed either way: the turn is not left to be read a second time at every later start.
    expect(existsSync(pending)).toBe(false);
    expect((await api<{ text: string }>(`/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).text).not.toContain("The person plays the cello on Sundays");
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);

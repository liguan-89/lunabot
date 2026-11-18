// The only engine is pi, which holds no provider instance of its own: the custom provider lives in
// `cfg.openaiCompat`. The old `openaiCompat` instance snapshot (state/authenticated/reason) is gone, so
// provider health is read from `GET /api/config` (is a key on file, its URL and models) and
// `POST /api/keys/test` (the provider's own verdict). Turn failure is driven through the fake pi's
// per-turn finish gate because the fixture's pi never calls the loopback provider itself.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { piDumpPath, piModelsSet } from "./testing/pi-dump.ts";
import { openSse } from "./testing/sse.ts";

const BAD = "fixture-revoked-key";
const GOOD = "fixture-working-key";

it("a key the provider rejects is reported until it changes or works again", async () => {
  let chat: "limit" | "auth" = "auth";
  const accepted = new Set([`Bearer ${GOOD}`]);
  const provider = createServer((req, res) => {
    req.resume();
    const key = req.headers.authorization ?? "";
    if (req.url === "/v1/models") {
      if (!accepted.has(key)) { res.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key" } })); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    if (!accepted.has(key)) {
      const [status, message] = chat === "limit" ? [429, "Rate limit reached"] : [401, "Incorrect API key provided"];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  // The fake pi's turn outcome is scripted per turn: "fail" mimics the provider refusing the key, "ok" a reply.
  const scratch = mkdtempSync(join(tmpdir(), "omb-key-rejected-"));
  const gate = join(scratch, "finish");
  writeFileSync(gate, "ok");
  const fixture = await launchVerificationServer({ FAKE_PI_MODE: "slow", FAKE_PI_SLOW_FINISH_GATE: gate });
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const config = async () => (await api("GET", "/api/config")).openaiCompat;
  const keyTest = () => api("POST", "/api/keys/test", { provider: "openaiCompat" });
  const turn = async (fails: boolean) => {
    writeFileSync(gate, fails ? "fail" : "ok");
    await control(["send", "--bot", bot.id, "--text", "Reply briefly."]);
    return control(["wait", "--bot", bot.id, "--timeout", "30"]);
  };
  let bot!: { id: string };
  try {
    // Patching config stays PATCH/PUT /api/config; there is no `instances` patch to add the retired engine.
    await api("PUT", "/api/config", {
      openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: BAD, model: "fixture-model" },
    });
    expect(await config()).toMatchObject({
      configured: true,
      url: `http://127.0.0.1:${address.port}/v1`,
      models: ["fixture-model"],
    });
    ({ bot } = await control(["new-bot", "--name", "Rejected key fixture"]));
    // The fixture's own pi instance runs the custom provider's `dex/fixture-model`. The config PUT above folds the
    // custom provider's models into pi's catalog asynchronously, so on a slow runner an immediate set-model races
    // that merge: retry until the catalog offers it.
    await expect.poll(async () => {
      try {
        await control(["set-model", "--bot", bot.id, "--instance", "pi", "--model", "dex/fixture-model"]);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 15_000, interval: 500 }).toBe(true);

    chat = "limit";
    expect((await turn(true)).status).toBe("failed");
    // The old "HTTP 401" row came from the retired driver's provider error; the fake pi never dials the
    // provider, so the turn-failure assertion survives while its exact error text has no successor.
    expect(piModelsSet(piDumpPath(fixture.info.dataDir)).at(-1)).toEqual({ provider: "dex", modelId: "fixture-model" });
    const afterLimit = await control(["messages", "--bot", bot.id, "--limit", "1"]);
    expect(afterLimit.bot.tasks.map((task: { title: string }) => task.title)).toHaveLength(1);

    chat = "auth";
    expect((await turn(true)).status).toBe("failed");
    // Successor to the old snapshot's authenticated:false + KEY_REJECTED_REASON: the keys test carries the verdict.
    const seq = sse.frames.at(-1)?.seq ?? 0;
    expect(await keyTest()).toMatchObject({ ok: false, reason: "rejected" });
    // A rejected key still marks the custom provider as configured (a key is on file).
    expect(await config()).toMatchObject({ configured: true });
    // The renderer refetches config on a config event; a rejection is one.
    await sse.until((frame) => frame.kind === "config" && frame.seq > seq);

    accepted.add(`Bearer ${BAD}`);
    expect(await keyTest()).toMatchObject({ ok: true });
    expect((await turn(false)).status).toBe("settled");

    accepted.delete(`Bearer ${BAD}`);
    expect((await turn(true)).status).toBe("failed");
    expect(await keyTest()).toMatchObject({ ok: false, reason: "rejected" });
    accepted.add(`Bearer ${BAD}`);
    expect((await turn(false)).status).toBe("settled");

    accepted.delete(`Bearer ${BAD}`);
    expect((await turn(true)).status).toBe("failed");
    expect(await keyTest()).toMatchObject({ ok: false, reason: "rejected" });
    await api("PUT", "/api/config", { openaiCompat: { key: GOOD } });
    expect(await config()).toMatchObject({ configured: true });
    expect(await keyTest()).toMatchObject({ ok: true });
    expect((await turn(false)).status).toBe("settled");

    const publicState = JSON.stringify([await api("GET", "/api/config"), await api("GET", "/api/instances"), sse.frames]);
    const logs = readFileSync(fixture.info.logPath, "utf8");
    for (const key of [BAD, GOOD]) {
      expect(publicState).not.toContain(key);
      expect(logs).not.toContain(key);
    }
  } finally {
    sse.close();
    await fixture.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await removeTempDir(scratch);
  }
}, 120_000);

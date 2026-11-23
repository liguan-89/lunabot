import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openSse } from "./testing/sse.ts";

it("saving and replacing the workspace provider key drives key testing without leaking keys", async () => {
  const received: string[] = [];
  const provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      // Deliberately public: this must never be presented as authenticated.
      received.push(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  try {
    const missing = await fetch(`${fixture.info.url}/api/keys/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat" }),
    });
    expect(missing.status).toBe(400);
    const configPath = join(fixture.info.dataDir, "config.json");
    const configBeforeInvalidUrls = readFileSync(configPath, "utf8");
    for (const url of ["htp://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=secret", `https://api.example.com/${"a".repeat(2048)}`]) {
      const response = await fetch(`${fixture.info.url}/api/config`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ openaiCompat: { url } }),
      });
      expect(response.status).toBe(400);
      expect(readFileSync(configPath, "utf8")).toBe(configBeforeInvalidUrls);
    }
    for (const url of ["http://127.example.test/v1", "http://127.0.0.1.example.test/v1"]) {
      expect(await api("POST", "/api/keys/test", { provider: "openaiCompat", key: "fixture-key", url }))
        .toEqual({ ok: false, reason: "unexpected" });
    }
    const status = await api("PUT", "/api/config", {
      openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: "fixture-first-key" },
    });
    expect(status.openaiCompat.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("fixture-first-key");
    // The save picks up the provider's own /models list: the second Bearer hit is that pickup.
    expect(status.openaiCompat.models).toEqual(["fixture-model"]);
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" }))
      .toEqual({ ok: true, check: "models", models: ["fixture-model"] });
    expect(received).toEqual(["Bearer fixture-first-key", "Bearer fixture-first-key"]);
    for (const key of ["", "   ", 123]) {
      const response = await fetch(`${fixture.info.url}/api/keys/test`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat", key }),
      });
      expect(response.status).toBe(400);
    }
    // A second save replaces the stored key: the next provider request carries the new one.
    await api("PUT", "/api/config", { openaiCompat: { key: "fixture-replacement-key" } });
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" })).toEqual({ ok: true, check: "models", models: ["fixture-model"] });
    // Replacing the stored key refreshes nothing else: models are already saved, so no extra pickup.
    expect(received).toEqual(["Bearer fixture-first-key", "Bearer fixture-first-key", "Bearer fixture-replacement-key"]);
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(disk.openaiCompat.key).toBe("fixture-replacement-key");
    const cleared = await api("PUT", "/api/config", { openaiCompat: { key: "" } });
    expect(cleared.openaiCompat.configured).toBe(false);
    const afterClear = await fetch(`${fixture.info.url}/api/keys/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat" }),
    });
    expect(afterClear.status).toBe(400);
    const publicState = JSON.stringify([await api("GET", "/api/bots"), await api("GET", "/api/config"), sse.frames]);
    const logs = readFileSync(fixture.info.logPath, "utf8");
    for (const key of ["fixture-first-key", "fixture-replacement-key"]) {
      expect(publicState).not.toContain(key);
      expect(logs).not.toContain(key);
    }
  } finally {
    sse.close();
    await fixture.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

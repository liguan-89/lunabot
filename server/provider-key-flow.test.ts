import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-lunabot.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openSse } from "./testing/sse.ts";

it("saving and replacing the workspace provider key drives key testing without leaking keys", async () => {
  const received: string[] = [];
  const catalogIds = Array.from({ length: 150 }, (_, index) => `fixture-model-${index}`);
  const provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      // Deliberately public: this must never be presented as authenticated.
      received.push(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: catalogIds.map((id) => ({ id })) }));
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
    expect(status.openaiCompat.models).toEqual(catalogIds);
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" }))
      .toEqual({ ok: true, check: "models", models: catalogIds.slice(0, 5) });
    expect(received).toEqual(["Bearer fixture-first-key", "Bearer fixture-first-key"]);
    for (const key of ["", "   ", 123]) {
      const response = await fetch(`${fixture.info.url}/api/keys/test`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat", key }),
      });
      expect(response.status).toBe(400);
    }
    // A second save replaces the stored key: the next provider request carries the new one.
    await api("PUT", "/api/config", { openaiCompat: { key: "fixture-replacement-key" } });
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" })).toEqual({ ok: true, check: "models", models: catalogIds.slice(0, 5) });
    // Replacing the stored key refreshes nothing else: models are already saved, so no extra pickup.
    expect(received).toEqual(["Bearer fixture-first-key", "Bearer fixture-first-key", "Bearer fixture-replacement-key"]);

    // 旧安装只保存过部分目录时，可用「重新检查」修复：pi 的 live 列表与提供方目录合并后再持久化；
    // 提供方没返回但用户已保存的 ID 也保留。
    await api("PUT", "/api/config", {
      openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, models: ["fixture-saved-model"] },
    });
    expect((await api("GET", "/api/config")).openaiCompat.models).toEqual(["fixture-saved-model"]);
    await api("POST", "/api/instances/pi/refresh-models", {});
    const synced = await api("GET", "/api/config");
    expect(synced.openaiCompat.models.slice(0, catalogIds.length)).toEqual(catalogIds);
    expect(synced.openaiCompat.models).toContain("fixture-saved-model");
    expect(synced.openaiCompat.models).toHaveLength(catalogIds.length + 1);
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(disk.openaiCompat.models).toEqual(synced.openaiCompat.models);
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

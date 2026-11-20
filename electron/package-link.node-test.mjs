import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL under this build's scheme and the one before it", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`lunabot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["Luna Bot", "--flag", `lunabot://install?url=${encodeURIComponent(target)}`]), target);
    // A link written before the rename still installs.
    assert.equal(packageUrlFromDeepLink(`dexbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromDeepLink(`lunabot://install?url=${encodeURIComponent(target)}`), target);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("lunabot://settings"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://settings"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://install?url=https://github.com/acme/bot/run.sh"), null);
    assert.equal(packageUrlFromDeepLink("lunabot://install?url=https://x.ai/bot/d8OshqLZvtcKDcNluPuyo"), null);
    assert.equal(packageUrlFromDeepLink("dexbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("https://install?url=https://evil.example/bot.json"), null);
  });
});

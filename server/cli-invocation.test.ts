import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/lunabot_ai/dist-server/lunabot.js")).toBe("npx lunabot_ai");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("lunabot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/lunabot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ LUNABOT_CLI_PREFIX: "docker compose exec omb lunabot" }, "/app/dist-server/lunabot.js")).toBe("docker compose exec omb lunabot");
    expect(cliPrefix({}, "/usr/lib/node_modules/lunabot_ai/dist-server/lunabot.js")).toBe("lunabot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\lunabot_ai\\x.js")).toBe("npx lunabot_ai pair");
    expect(cliPrefix({}, "/home/me/.npm-global/bin/lunabot")).toBe("lunabot");
  });
});

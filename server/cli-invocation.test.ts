import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/openmausbot/dist-server/openmausbot.js")).toBe("npx openmausbot");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("lunabot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/openmausbot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ OMB_CLI_PREFIX: "docker compose exec omb openmausbot" }, "/app/dist-server/openmausbot.js")).toBe("docker compose exec omb openmausbot");
    expect(cliPrefix({}, "/usr/lib/node_modules/openmausbot/dist-server/openmausbot.js")).toBe("openmausbot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\openmausbot\\x.js")).toBe("npx openmausbot pair");
    // The npm package's other bin: its shell sees its own name, not the current one.
    expect(cliPrefix({}, "/usr/lib/node_modules/dexbot/dist-server/openmausbot.js")).toBe("lunabot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\dexbot\\x.js")).toBe("npx lunabot pair");
    expect(cliPrefix({}, "/usr/lib/node_modules/lunabot/dist-server/openmausbot.js")).toBe("lunabot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\lunabot\\x.js")).toBe("npx lunabot pair");
    expect(cliPrefix({}, "/home/me/.npm-global/bin/lunabot")).toBe("lunabot");
  });
});

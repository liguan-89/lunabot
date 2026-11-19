import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureDesktopScreen,
  DESKTOP_SCREEN_ACTIONS,
  desktopScreenRefusal,
  desktopScreenSocket,
  performDesktopScreenAction,
} from "./desktop-screen.ts";
import type { LocalComputerConnection } from "./local-computer.ts";

/**
 * Every test here drives a scripted stand-in for the desktop's Cua Driver, so nothing needs a Mac and nothing can touch
 * a real screen.
 *
 * The stand-in is an executable file with a node shebang, because `callDriver` builds the argv itself
 * (`call <tool> <json> --socket <path>`, the real binary's shape) and ignores `connection.args`. A file command keeps
 * that shape: argv[1] is the subcommand, argv[2] the tool and argv[3] its JSON, exactly as the driver sees them.
 */
function driverConnection(script: string): LocalComputerConnection {
  const scratch = mkdtempSync(join(tmpdir(), "lunabot-driver-"));
  // CommonJS: the stand-in uses require(), and an .mjs file would not have it.
  const file = join(scratch, "driver.cjs");
  writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return {
    command: file,
    // The descriptor's own args name the socket; `desktopScreenSocket` reads them and `callDriver` rebuilds the rest.
    args: ["mcp", "--embedded", "--socket", "/tmp/fake-driver.sock"],
    env: {},
    platform: "linux",
    scope: "local-computer",
  };
}

/** A driver that answers a capture by writing [pngBase64] where it is told and printing [stdout]. */
function captureDriver({ stdout, pngBase64 }: { stdout: string; pngBase64?: string }): string {
  const write = pngBase64
    ? `const args = JSON.parse(process.argv[4] ?? "{}");
       if (args.screenshot_out_file) require("node:fs").writeFileSync(args.screenshot_out_file, Buffer.from(${JSON.stringify(pngBase64)}, "base64"));`
    : "";
  return `if (process.argv[2] !== "call") process.exit(2);
    ${write}
    console.log(${JSON.stringify(stdout)});`;
}

/** A driver that writes each call's tool and arguments to the file named in RECORD_PATH, then exits 0. */
const RECORDER = `if (process.argv[2] !== "call") process.exit(2);
  require("node:fs").appendFileSync(process.env.RECORD_PATH, JSON.stringify({ tool: process.argv[3], args: JSON.parse(process.argv[4] ?? "{}") }) + "\\n");`;

/** A one-pixel PNG: enough for wholeScreenshot to accept it as a complete image. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("desktopScreenSocket", () => {
  it("reads the --socket argument the app's descriptor carries", () => {
    expect(desktopScreenSocket({ ...driverConnection(""), args: ["mcp", "--embedded", "--socket", "/tmp/a.sock"] })).toBe("/tmp/a.sock");
  });

  it("refuses a socket that is not an absolute path, and one with no --socket at all", () => {
    expect(desktopScreenSocket({ ...driverConnection(""), args: ["mcp", "--socket", "relative.sock"] })).toBeNull();
    expect(desktopScreenSocket({ ...driverConnection(""), args: ["mcp"] })).toBeNull();
  });
});

describe("desktopScreenRefusal", () => {
  it("accepts a point click and refuses one without coordinates", () => {
    expect(desktopScreenRefusal({ action: "click", x: 10, y: 20 })).toBeNull();
    expect(desktopScreenRefusal({ action: "click" })).toContain("x and y");
  });

  it("accepts typed text and refuses an empty or oversized run", () => {
    expect(desktopScreenRefusal({ action: "type_text", text: "hello" })).toBeNull();
    expect(desktopScreenRefusal({ action: "type_text", text: "" })).toContain("needs text");
    expect(desktopScreenRefusal({ action: "type_text", text: "x".repeat(4_001) })).toContain("longer than");
  });

  it("needs a direction for scroll and a key for press_key", () => {
    expect(desktopScreenRefusal({ action: "scroll", x: 1, y: 2, key: "down" })).toBeNull();
    expect(desktopScreenRefusal({ action: "scroll", x: 1, y: 2 })).toContain("direction");
    expect(desktopScreenRefusal({ action: "press_key" })).toContain("key name");
  });

  it("keeps modifiers to the four the driver knows", () => {
    expect(desktopScreenRefusal({ action: "press_key", key: "a", modifiers: ["cmd", "shift"] })).toBeNull();
    expect(desktopScreenRefusal({ action: "press_key", key: "a", modifiers: ["hyper"] })).toContain("cmd, shift");
  });

  it("refuses an action this screen does not offer", () => {
    expect(desktopScreenRefusal({ action: "launch_app" as never })).toContain(DESKTOP_SCREEN_ACTIONS[0]);
  });
});

describe("captureDesktopScreen", () => {
  it("returns the picture and the two sizes a tap needs", async () => {
    const frame = await captureDesktopScreen(
      driverConnection(
        captureDriver({
          stdout: JSON.stringify({ screen_width: 1710, screen_height: 1107, screenshot_width: 1280, screenshot_height: 829 }),
          pngBase64: PNG,
        }),
      ),
      { maxImageDimension: 1280 },
    );
    expect(frame.png).not.toBe(PNG);
    // macOS re-encodes the driver's PNG to JPEG (`sips`), so the bytes are not the ones the stand-in wrote. What matters
    // is that a whole picture came back, in a format the phone can decode, with the sizes a tap is scaled by.
    expect(Buffer.from(frame.png, "base64").length).toBeGreaterThan(512);
    expect(frame.mime).toBe(process.platform === "darwin" ? "image/jpeg" : "image/png");
    expect([frame.imageWidth, frame.imageHeight]).toEqual([1280, 829]);
    expect([frame.screenWidth, frame.screenHeight]).toEqual([1710, 1107]);
  });

  it("asks for the long-edge cap it was given", async () => {
    const frame = await captureDesktopScreen(
      driverConnection(
        `if (process.argv[2] !== "call") process.exit(2);
         const args = JSON.parse(process.argv[4] ?? "{}");
         require("node:fs").writeFileSync(args.screenshot_out_file, Buffer.from(${JSON.stringify(PNG)}, "base64"));
         console.log(JSON.stringify({ screen_width: 10, screen_height: 10, screenshot_width: 5, screenshot_height: 5, cap: args.max_image_dimension }));`,
      ),
      { maxImageDimension: 900 },
    );
    expect(frame.imageWidth).toBe(5);
  });

  it("refuses a driver that answers without the screen size", async () => {
    await expect(
      captureDesktopScreen(driverConnection(captureDriver({ stdout: JSON.stringify({ ok: true }), pngBase64: PNG }))),
    ).rejects.toThrow(/without its size/);
  });

  it("refuses a driver that writes no picture", async () => {
    await expect(
      captureDesktopScreen(
        driverConnection(
          captureDriver({ stdout: JSON.stringify({ screen_width: 1, screen_height: 1, screenshot_width: 1, screenshot_height: 1 }) }),
        ),
      ),
    ).rejects.toThrow(/no picture/);
  });

  it("surfaces the driver's own sentence rather than an exit code", async () => {
    const failing = `if (process.argv[2] !== "call") process.exit(2);
      console.error(JSON.stringify({ error: { message: "Screen Recording is not granted" } }));
      process.exit(1);`;
    await expect(captureDesktopScreen(driverConnection(failing))).rejects.toThrow(/Screen Recording is not granted/);
  });
});

describe("performDesktopScreenAction", () => {
  it("refuses before spawning when the action is malformed", async () => {
    const neverRuns: LocalComputerConnection = { ...driverConnection(""), command: "/nonexistent/lunabot-driver", args: ["mcp", "--socket", "/tmp/x.sock"] };
    await expect(performDesktopScreenAction(neverRuns, { action: "click" } as never)).rejects.toThrow(/x and y/);
  });

  it("sends a click as desktop-scoped screen points", async () => {
    const call = await recordedCall({ action: "click", x: 120, y: 340 });
    expect(call.tool).toBe("click");
    expect(call.args).toMatchObject({ x: 120, y: 340, scope: "desktop", post_action_wait: "none" });
  });

  it("sends a double click as one click with count 2, because that tool takes no scope", async () => {
    const call = await recordedCall({ action: "double_click", x: 5, y: 6 });
    expect(call.tool).toBe("click");
    expect(call.args).toMatchObject({ x: 5, y: 6, count: 2, scope: "desktop" });
  });

  it("sends scroll with its direction and amount", async () => {
    const call = await recordedCall({ action: "scroll", x: 1, y: 2, key: "down", amount: 4 });
    expect(call.tool).toBe("scroll");
    expect(call.args).toMatchObject({ direction: "down", amount: 4, scope: "desktop" });
  });

  it("types with foreground delivery, since a Mac field needs focus", async () => {
    const call = await recordedCall({ action: "type_text", text: "hi" });
    expect(call.tool).toBe("type_text");
    expect(call.args).toMatchObject({ text: "hi", scope: "desktop", delivery_mode: "foreground" });
  });

  it("presses a key with its modifiers, and a chord as hotkey", async () => {
    const press = await recordedCall({ action: "press_key", key: "c", modifiers: ["cmd"] });
    expect(press.tool).toBe("press_key");
    expect(press.args).toMatchObject({ key: "c", modifiers: ["cmd"] });
    const chord = await recordedCall({ action: "hotkey", key: "Tab", modifiers: ["cmd"] });
    expect(chord.tool).toBe("hotkey");
    expect(chord.args).toMatchObject({ keys: ["Tab", "cmd"] });
  });
});

/** Run one action against the recording driver and return the single call it made. */
async function recordedCall(request: Parameters<typeof performDesktopScreenAction>[1]): Promise<{ tool: string; args: Record<string, unknown> }> {
  const scratch = mkdtempSync(join(tmpdir(), "lunabot-screen-test-"));
  const record = join(scratch, "calls.jsonl");
  const conn: LocalComputerConnection = {
    ...driverConnection(RECORDER),
    env: { RECORD_PATH: record },
  };
  try {
    await performDesktopScreenAction(conn, request);
    const lines = readFileSync(record, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The adhoc swap: stage the bundle out of the disk image, arm the detached script, and — on systems with sh — run the
// script itself against fixture bundles to see the replace and the rollback.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImageInstall, SWAP_SCRIPT } from "./image-install.mjs";

const plist = (point) => `<?xml version="1.0"?>
<plist><array><dict>
  <key>system-entities</key>
  <array><dict><key>mount-point</key><string>${point}</string></dict></array>
</dict></array>
</plist>`;

function fixtureApp(dir, marker) {
  const app = join(dir, "Luna Bot.app", "Contents", "Resources");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, marker), marker);
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "omb-image-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A `run` that mounts the fixture directory, copies on ditto, and records every call. */
function fakeRun(mountDir, calls, { dittoFails = false } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "hdiutil" && args[0] === "attach") return { stdout: plist(mountDir) };
    if (cmd === "hdiutil" && args[0] === "detach") return { stdout: "" };
    if (cmd === "ditto") {
      if (dittoFails) throw new Error("ditto failed");
      execFileSync("cp", ["-R", args[0], args[1]]);
      return { stdout: "" };
    }
    throw new Error(`unexpected ${cmd}`);
  };
}

test("install stages the bundle from the mounted image and arms the detached swap", async (t) => {
  const dir = workspace(t);
  const mount = join(dir, "mount");
  fixtureApp(mount, "new.marker");
  const calls = [];
  const spawned = [];
  const install = createImageInstall({
    run: fakeRun(mount, calls),
    spawnImpl: (cmd, args, options) => { spawned.push({ cmd, args, options }); return { unref() {} }; },
    logFile: join(dir, "updater.log"),
  });

  const staged = await install.install(join(dir, "LUNABOT-2.1.8-arm64.dmg"), {
    stagingDir: join(dir, "staged"), targetApp: join(dir, "Applications", "Luna Bot.app"), pid: 1234, version: "2.1.8",
  });

  assert.equal(staged, join(dir, "staged", "Luna Bot.app"));
  assert.equal(readFileSync(join(staged, "Contents", "Resources", "new.marker"), "utf8"), "new.marker");
  assert.deepEqual(calls.map(([cmd, ...args]) => [cmd, args[0]]), [["hdiutil", "attach"], ["ditto", join(mount, "Luna Bot.app")], ["hdiutil", "detach"]]);

  assert.equal(spawned.length, 1);
  const { cmd, args, options } = spawned[0];
  assert.equal(cmd, "sh");
  assert.equal(args[0], "-c");
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.env.LUNABOT_SWAP_PID, "1234");
  assert.equal(options.env.LUNABOT_SWAP_TARGET, join(dir, "Applications", "Luna Bot.app"));
  assert.equal(options.env.LUNABOT_SWAP_STAGED, staged);
});

test("an image that does not mount throws before anything is armed", async (t) => {
  const dir = workspace(t);
  const spawned = [];
  const install = createImageInstall({
    run: async () => ({ stdout: "<plist/>" }),
    spawnImpl: () => { spawned.push(1); return { unref() {} }; },
  });
  await assert.rejects(install.install(join(dir, "x.dmg"), { stagingDir: join(dir, "s"), targetApp: join(dir, "a"), pid: 1 }), /did not mount/);
  assert.equal(spawned.length, 0);
});

test("a ditto failure still detaches the image", async (t) => {
  const dir = workspace(t);
  const mount = join(dir, "mount");
  fixtureApp(mount, "new.marker");
  const calls = [];
  const install = createImageInstall({ run: fakeRun(mount, calls, { dittoFails: true }), spawnImpl: () => ({ unref() {} }) });
  await assert.rejects(install.install(join(dir, "x.dmg"), { stagingDir: join(dir, "s"), targetApp: join(dir, "a"), pid: 1 }), /ditto failed/);
  assert.equal(calls.at(-1)[0], "hdiutil");
  assert.equal(calls.at(-1)[1], "detach");
});

const SH = process.platform !== "win32";

/** Runs the swap script to completion against a dead pid; returns its exit code. */
function runSwap(env) {
  try {
    execFileSync("sh", ["-c", SWAP_SCRIPT, "swap"], { env: { ...process.env, ...env }, stdio: "pipe" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/** A PATH directory of stand-ins for the macOS-only tools the swap script calls. */
function shims(dir, { dittoOk = true } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  shim("open", "exit 0");
  shim("xattr", "exit 0");
  shim("ditto", dittoOk ? 'cp -R "$1" "$2"' : "exit 1");
  return bin;
}

test("the swap waits for the app to leave, replaces the bundle and reopens it", { skip: !SH }, (t) => {
  const dir = workspace(t);
  const target = join(dir, "Applications", "Luna Bot.app");
  const staged = join(dir, "staged", "Luna Bot.app");
  fixtureApp(join(dir, "Applications"), "old.marker");
  fixtureApp(join(dir, "staged"), "new.marker");
  const log = join(dir, "updater.log");

  const code = runSwap({
    PATH: `${shims(dir)}:${process.env.PATH}`,
    LUNABOT_SWAP_PID: "99999999", LUNABOT_SWAP_TARGET: target, LUNABOT_SWAP_STAGED: staged, LUNABOT_SWAP_LOG: log,
    LUNABOT_SWAP_VERSION: "2.1.8",
  });

  assert.equal(code, 0);
  assert.equal(readFileSync(join(target, "Contents", "Resources", "new.marker"), "utf8"), "new.marker");
  assert.equal(existsSync(join(target, "Contents", "Resources", "old.marker")), false);
  assert.equal(existsSync(`${target}.lunabot-swap-old`), false);
  assert.equal(existsSync(staged), false);
  assert.match(readFileSync(log, "utf8"), /installed 2\.1\.8/);
});

test("a failed copy restores the previous bundle", { skip: !SH }, (t) => {
  const dir = workspace(t);
  const target = join(dir, "Applications", "Luna Bot.app");
  const staged = join(dir, "staged", "Luna Bot.app");
  fixtureApp(join(dir, "Applications"), "old.marker");
  fixtureApp(join(dir, "staged"), "new.marker");

  const code = runSwap({
    PATH: `${shims(dir, { dittoOk: false })}:${process.env.PATH}`,
    LUNABOT_SWAP_PID: "99999999", LUNABOT_SWAP_TARGET: target, LUNABOT_SWAP_STAGED: staged, LUNABOT_SWAP_LOG: join(dir, "u.log"),
  });

  assert.equal(code, 1);
  assert.equal(readFileSync(join(target, "Contents", "Resources", "old.marker"), "utf8"), "old.marker");
  assert.equal(existsSync(`${target}.lunabot-swap-old`), false);
});

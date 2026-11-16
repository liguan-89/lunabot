import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DESKTOP_PROTOCOLS, LINUX_DESKTOP_NAME, prepareDesktopProfile, registerDesktopProtocols } from "./desktop-identity.mjs";

test("this build answers lunabot:// and still answers dexbot://, in that order", () => {
  assert.deepEqual(DESKTOP_PROTOCOLS, ["lunabot", "dexbot"]);
  const registered = [];
  registerDesktopProtocols({ setAsDefaultProtocolClient: (scheme) => { registered.push(scheme); return true; } });
  assert.deepEqual(registered, ["lunabot", "dexbot"]);
});

test("GNOME's desktop-entry name matches the app id", () => {
  assert.equal(LINUX_DESKTOP_NAME, "com.lunabot.app.desktop");
});

test("a source run leaves the installed profile alone; a packaged run moves the pre-rename one", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-desktop-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, "DEX BOT");
  const current = path.join(root, "Luna Bot");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "window-state.json"), "kept");

  assert.equal(prepareDesktopProfile({ isPackaged: false, getPath: () => assert.fail("a source run must not read userData") }), null);
  assert.equal(existsSync(legacy), true);

  const result = prepareDesktopProfile({ isPackaged: true, getPath: () => current }, () => {}, { candidates: [legacy] });
  assert.deepEqual(result, { migrated: true, from: legacy, to: current });
  assert.equal(readFileSync(path.join(current, "window-state.json"), "utf8"), "kept");
});

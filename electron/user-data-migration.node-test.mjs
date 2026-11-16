import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { legacyUserDataDirs, migrateDataDir, migrateUserData, moveIntoPlace } from "./user-data-migration.mjs";

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "omb-user-data-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = [];
  return { root, logs, log: (line) => logs.push(line) };
}

const put = (dir, name, content) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
};

test("moves the old profile into the new name when the new folder is missing", (t) => {
  const { root, logs, log } = sandbox(t);
  const legacy = path.join(root, "Application Support", "DEX BOT");
  const current = path.join(root, "Application Support", "Luna Bot");
  put(legacy, "window-state.json", "kept");

  const result = migrateUserData({ currentDir: current, candidates: [legacy], log });

  assert.deepEqual(result, { migrated: true, from: legacy, to: current });
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(path.join(current, "window-state.json"), "utf8"), "kept");
  assert.match(logs.join("\n"), /moved .*DEX BOT.* to .*Luna Bot/);
});

test("moves the old profile when the new folder exists but holds nothing", (t) => {
  const { root, log } = sandbox(t);
  const legacy = path.join(root, "dexbot");
  const current = path.join(root, "Luna Bot");
  put(legacy, "credentials.bin", "secret");
  mkdirSync(current);

  assert.equal(migrateUserData({ currentDir: current, candidates: [legacy], log }).migrated, true);
  assert.equal(readFileSync(path.join(current, "credentials.bin"), "utf8"), "secret");
});

test("does nothing when the new profile already holds data", (t) => {
  const { root, log } = sandbox(t);
  const legacy = path.join(root, "DEX BOT");
  const current = path.join(root, "Luna Bot");
  put(legacy, "old.json", "old");
  put(current, "new.json", "new");

  assert.deepEqual(migrateUserData({ currentDir: current, candidates: [legacy], log }), { migrated: false, from: legacy, to: current });
  assert.equal(readFileSync(path.join(current, "new.json"), "utf8"), "new");
  assert.equal(readFileSync(path.join(legacy, "old.json"), "utf8"), "old", "the old folder is left alone, not merged");
});

test("does nothing when the old profile is missing", (t) => {
  const { root, log } = sandbox(t);
  const current = path.join(root, "Luna Bot");

  assert.deepEqual(migrateUserData({ currentDir: current, candidates: [path.join(root, "DEX BOT")], log }), { migrated: false, from: null, to: current });
  assert.equal(existsSync(current), false, "no folder is created just to look at it");
});

test("a failed move leaves both folders as they were and never throws", (t) => {
  const { root, logs, log } = sandbox(t);
  const legacy = path.join(root, "DEX BOT");
  const current = path.join(root, "Luna Bot");
  put(legacy, "kept.json", "kept");
  const files = {
    existsSync: (file) => existsSync(file),
    statSync: (...args) => statSync(...args),
    readdirSync: (...args) => readdirSync(...args),
    renameSync: () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); },
  };

  assert.equal(migrateUserData({ currentDir: current, candidates: [legacy], files, log }).migrated, false);
  assert.equal(readFileSync(path.join(legacy, "kept.json"), "utf8"), "kept");
  assert.match(logs.join("\n"), /cross-device link/);
});

test("names the profile folder each platform's earlier build wrote", () => {
  const home = "/Users/ash";
  assert.deepEqual(legacyUserDataDirs({ platform: "darwin", home, env: {} }), [
    path.posix.join(home, "Library", "Application Support", "DEX BOT"),
    path.posix.join(home, "Library", "Application Support", "dexbot"),
  ]);
  assert.deepEqual(legacyUserDataDirs({ platform: "win32", home: "C:\\Users\\ash", env: { APPDATA: "C:\\Users\\ash\\AppData\\Roaming" } }), [
    path.win32.join("C:\\Users\\ash\\AppData\\Roaming", "dexbot"),
    path.win32.join("C:\\Users\\ash\\AppData\\Roaming", "DEX BOT"),
  ]);
  assert.deepEqual(legacyUserDataDirs({ platform: "linux", home: "/home/ash", env: {} }), [
    path.posix.join("/home/ash", ".config", "dexbot"),
    path.posix.join("/home/ash", ".config", "DEX BOT"),
  ]);
  assert.deepEqual(legacyUserDataDirs({ platform: "linux", home: "/home/ash", env: { XDG_CONFIG_HOME: "/cfg" } })[0], "/cfg/dexbot");
});

test("the bot data folder moves from ~/.dexbot to ~/.lunabot once, and never over existing data", (t) => {
  const { root, logs, log } = sandbox(t);
  const legacy = path.join(root, ".dexbot");
  put(legacy, "config.json", "kept");

  assert.equal(migrateDataDir({ home: root, log }), path.join(root, ".lunabot"));
  assert.equal(readFileSync(path.join(root, ".lunabot", "config.json"), "utf8"), "kept");
  assert.equal(existsSync(legacy), false);
  assert.match(logs.join("\n"), /moved .*\.dexbot.* to .*\.lunabot/);

  // A second boot has nothing left to move.
  assert.equal(migrateDataDir({ home: root, log }), path.join(root, ".lunabot"));
});

test("a fresh install just uses ~/.lunabot, and an existing ~/.lunabot wins over a stale ~/.dexbot", (t) => {
  const { root, log } = sandbox(t);
  assert.equal(migrateDataDir({ home: root, log }), path.join(root, ".lunabot"));
  assert.equal(existsSync(path.join(root, ".lunabot")), false, "looking never creates the folder");

  put(path.join(root, ".lunabot"), "config.json", "new");
  put(path.join(root, ".dexbot"), "config.json", "old");
  assert.equal(migrateDataDir({ home: root, log }), path.join(root, ".lunabot"));
  assert.equal(readFileSync(path.join(root, ".lunabot", "config.json"), "utf8"), "new");
  assert.equal(readFileSync(path.join(root, ".dexbot", "config.json"), "utf8"), "old");
});

test("a data folder that cannot move is still the folder to use", (t) => {
  const { root, logs, log } = sandbox(t);
  put(path.join(root, ".dexbot"), "config.json", "kept");
  const files = {
    existsSync: (file) => existsSync(file),
    renameSync: () => { throw new Error("busy"); },
  };

  assert.equal(migrateDataDir({ home: root, files, log }), path.join(root, ".dexbot"));
  assert.match(logs.join("\n"), /busy/);
});

test("moveIntoPlace refuses the same path twice and a missing source", (t) => {
  const { root } = sandbox(t);
  const dir = path.join(root, "one");
  put(dir, "a.txt", "a");
  assert.equal(moveIntoPlace(dir, dir), false);
  assert.equal(moveIntoPlace(path.join(root, "gone"), path.join(root, "two")), false);
  assert.equal(moveIntoPlace(dir, path.join(root, "two")), true);
  assert.equal(readFileSync(path.join(root, "two", "a.txt"), "utf8"), "a");
});

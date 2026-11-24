import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAMES, resolveDataDir } from "./data-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "lunabot-data-dir-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) removeTempDir(dir);
});

describe("resolveDataDir", () => {
  it("is ~/.lunabot when the home has no data folder yet", () => {
    const dir = home();
    expect(resolveDataDir({}, { home: dir })).toBe(join(dir, DATA_DIR_NAME));
    expect(existsSync(join(dir, DATA_DIR_NAME))).toBe(false);
  });

  it.each(LEGACY_DATA_DIR_NAMES)("renames a lone %s to ~/.lunabot, keeping what is in it", (legacyName) => {
    const dir = home();
    const legacy = join(dir, legacyName);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.json"), "{}");

    expect(resolveDataDir({}, { home: dir })).toBe(join(dir, DATA_DIR_NAME));
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(dir, DATA_DIR_NAME, "config.json"), "utf8")).toBe("{}");
  });

  it("leaves a legacy folder alone when ~/.lunabot already exists", () => {
    const dir = home();
    const legacy = join(dir, LEGACY_DATA_DIR_NAMES[0]);
    mkdirSync(join(dir, DATA_DIR_NAME));
    writeFileSync(join(dir, DATA_DIR_NAME, "kept.txt"), "new");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "old.txt"), "old");

    expect(resolveDataDir({}, { home: dir })).toBe(join(dir, DATA_DIR_NAME));
    expect(readFileSync(join(dir, DATA_DIR_NAME, "kept.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(legacy, "old.txt"), "utf8")).toBe("old");
  });

  it("uses LUNABOT_DATA_DIR as given, and never migrates around it", () => {
    const dir = home();
    mkdirSync(join(dir, LEGACY_DATA_DIR_NAMES[0]));
    const custom = join(dir, "elsewhere");

    expect(resolveDataDir({ LUNABOT_DATA_DIR: custom }, { home: dir })).toBe(custom);
    expect(existsSync(join(dir, LEGACY_DATA_DIR_NAMES[0]))).toBe(true);
    expect(existsSync(join(dir, DATA_DIR_NAME))).toBe(false);
  });

  it("adopts a lone legacy folder when LUNABOT_DATA_DIR names the canonical one", () => {
    const dir = home();
    const legacy = join(dir, LEGACY_DATA_DIR_NAMES[0]);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.json"), "{}");
    const configured = join(dir, DATA_DIR_NAME);

    expect(resolveDataDir({ LUNABOT_DATA_DIR: configured }, { home: dir })).toBe(configured);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(configured, "config.json"), "utf8")).toBe("{}");
  });

  it("joins with the platform's own separator, as a Cloud volume needs", () => {
    const calls: Array<[string, string]> = [];
    const posix = (base: string, name: string) => {
      calls.push([base, name]);
      return `${base}/${name}`;
    };
    expect(resolveDataDir({}, { home: "/data", join: posix })).toBe(`/data/${DATA_DIR_NAME}`);
    expect(calls).toContainEqual(["/data", DATA_DIR_NAME]);
  });
});

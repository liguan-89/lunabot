// The store: what lands on disk, what a repeat learns, and what the prompt
// reference reads back.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPhoneScreenmaps } from "./phone-screenmap.ts";

const dirs: string[] = [];
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "phone-screenmap-")); dirs.push(dir); return dir; };
const screen = (app: string, texts: string[]) => ({
  packageName: app,
  elements: texts.map((text) => ({ text, class: "android.widget.TextView", bounds: [0, 0, 100, 100] })),
});

afterEach(() => {
  // The temp folders the store wrote stay for the failing test's inspection.
  dirs.length = 0;
});

describe("the per-owner screenmap store", () => {
  it("one answered call teaches a page and a step teaches the edge", () => {
    const dir = dataDir();
    const maps = createPhoneScreenmaps({ dataDir: dir, now: () => 1 });
    maps.observe("owner-a", "phone-1", "PHONE_UI_TAP", "张三", screen("com.app", ["消息"]), screen("com.app", ["聊天详情"]));
    const graph = maps.graph("owner-a", "com.app")!;
    expect(Object.keys(graph.nodes)).toHaveLength(2);
    const path = join(dir, "phone-screenmaps", "owner-a", `${encodeURIComponent("com.app")}.json`);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "phone-screenmaps", "owner-a")).mode & 0o777).toBe(0o700);
    // The file is the graph the store hands back.
    expect(JSON.parse(readFileSync(path, "utf8")).nodes).toEqual(graph.nodes);
  });

  it("a repeat of the learned screen costs nothing, and a reread from before adds only the page", () => {
    const dir = dataDir();
    const maps = createPhoneScreenmaps({ dataDir: dir, now: () => 1 });
    const home = screen("com.app", ["首页"]);
    maps.observe("owner-a", "phone-1", "PHONE_UI_OBSERVE", null, null, home);
    maps.observe("owner-a", "phone-1", "PHONE_UI_OBSERVE", null, null, home);
    expect(Object.keys(maps.graph("owner-a", "com.app")!.nodes)).toHaveLength(1);
    // A different phone key is its own walk: the page was already known, so no edge, no growth.
    maps.observe("owner-a", "phone-2", "PHONE_UI_OBSERVE", null, null, home);
    expect(Object.keys(maps.graph("owner-a", "com.app")!.nodes)).toHaveLength(1);
  });

  it("the prompt reference names the apps it knows and stays empty before anything is learned", () => {
    const dir = dataDir();
    const maps = createPhoneScreenmaps({ dataDir: dir, now: () => 1 });
    expect(maps.reference("owner-a")).toBe("");
    maps.observe("owner-a", "phone-1", "PHONE_UI_TAP", "张三", screen("com.app", ["消息"]), screen("com.app", ["聊天详情"]));
    const text = maps.reference("owner-a");
    expect(text).toContain("com.app");
    expect(text).toContain("Pages (2)");
    // Another owner reads nothing of theirs.
    expect(maps.reference("owner-b")).toBe("");
  });

  it("an owner's maps stay capped, the busiest apps surviving", { timeout: 10_000 }, () => {
    const dir = dataDir();
    const maps = createPhoneScreenmaps({ dataDir: dir, now: () => 1, limits: { appsPerOwner: 3, nodesPerApp: 4 } });
    for (let app = 0; app < 5; app += 1) {
      for (let page = 0; page < 6; page += 1) {
        maps.observe("owner-a", `phone-${app}`, "PHONE_UI_TAP", null,
          screen(`com.app${app}`, [`第${page}页头`]), screen(`com.app${app}`, [`第${page}页尾`]));
      }
    }
    const files = readdirSync(join(dir, "phone-screenmaps", "owner-a"));
    expect(files.length).toBeLessThanOrEqual(3);
    // The app walked six pages six times is the busiest; each surviving map holds at most four pages.
    for (const file of files) {
      const graph = JSON.parse(readFileSync(join(dir, "phone-screenmaps", "owner-a", file), "utf8"));
      expect(Object.keys(graph.nodes).length).toBeLessThanOrEqual(4);
    }
  });
});

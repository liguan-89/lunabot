import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBotPackageExport } from "./package-export.ts";
import type { BotRecord } from "./store.ts";
import { deleteTemplate, listTemplates, readTemplate, saveTemplate, templateSlug } from "./templates.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "omb-templates-"));
  dirs.push(made);
  return made;
}

function packageDocument() {
  const bot: BotRecord = {
    id: "b1", threadId: "t1", name: "Lead", title: "Researcher", description: "Researches leads",
    notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
    resumeCursors: {}, createdAt: 1,
  };
  return createBotPackageExport({ name: "Research Team", authorName: "Ada", bots: [bot], groups: [], routines: [] });
}

describe("the local template library", () => {
  it("slugs names for safe file names, rejecting what cannot spell one", () => {
    expect(templateSlug("My Research Team!")).toBe("my-research-team");
    expect(templateSlug("  客服 团队  ")).toBeNull();
    expect(templateSlug("a")).toBe("a");
    expect(templateSlug("x".repeat(120))).toBe("x".repeat(80));
  });

  it("saves a parsed package, lists it with its summary, reads it back for install", () => {
    const home = dir();
    const entry = saveTemplate(home, packageDocument());
    expect(entry.slug).toBe("research-team");
    expect(entry.summary).toMatchObject({ kind: "team", name: "Research Team", counts: { bots: 1 } });

    const listed = listTemplates(home);
    expect(listed).toHaveLength(1);
    expect(listed[0].slug).toBe("research-team");
    expect(listed[0].savedAt).toBeTruthy();

    const back = readTemplate(home, "research-team");
    expect(back?.package.name).toBe("Research Team");
    expect(readTemplate(home, "missing")).toBeNull();
    expect(readTemplate(home, "../etc")).toBeNull();
  });

  it("overwrites a template of the same name, honors an explicit save name, deletes", () => {
    const home = dir();
    saveTemplate(home, packageDocument());
    const renamed = saveTemplate(home, packageDocument(), "Second Library");
    expect(renamed.slug).toBe("second-library");
    expect(listTemplates(home).map((t) => t.slug)).toEqual(["research-team", "second-library"]);
    expect(deleteTemplate(home, "research-team")).toBe(true);
    expect(deleteTemplate(home, "research-team")).toBe(false);
    expect(listTemplates(home).map((t) => t.slug)).toEqual(["second-library"]);
  });

  it("refuses documents that are not packages and skips unreadable files in the list", () => {
    const home = dir();
    expect(() => saveTemplate(home, { not: "a package" })).toThrow();
    writeFileSync(join(home, "broken.json"), "{ not json");
    writeFileSync(join(home, "stray.txt"), "{}");
    expect(listTemplates(home)).toEqual([]);
    expect(readTemplate(home, "broken")).toBeNull();
  });
});

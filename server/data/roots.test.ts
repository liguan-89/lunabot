import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dataExportFolders, exportFolders } from "./roots.ts";

let dir = "";
let downloads = "";

/** This machine's real Downloads, when it has one, so expectations hold everywhere. */
const machineDownloads = (roots: string[]): string[] => {
  const found = join(homedir(), "Downloads");
  return existsSync(found) ? [found, ...roots] : roots;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-export-folders-"));
  downloads = join(dir, "downloads");
  mkdirSync(downloads);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("exportFolders", () => {
  it("offers Downloads, the bot's configured folder and the workspace without a conversation", () => {
    expect(exportFolders({ downloads, workspace: join(dir, "workspace"), configured: join(dir, "project") }))
      .toEqual([downloads, join(dir, "project"), join(dir, "workspace")]);
  });

  it("offers the conversation's folder instead of the configured one", () => {
    expect(exportFolders({ downloads, workspace: join(dir, "workspace"), configured: join(dir, "project"), conversation: join(dir, "task-workspaces", "bot", "thread") }))
      .toEqual([downloads, join(dir, "task-workspaces", "bot", "thread"), join(dir, "workspace")]);
  });

  it("drops the configured folder when the conversation pinned none", () => {
    expect(exportFolders({ downloads, workspace: join(dir, "workspace"), configured: join(dir, "project"), conversation: null }))
      .toEqual([downloads, join(dir, "workspace")]);
  });

  it("skips Downloads the machine does not have", () => {
    expect(exportFolders({ downloads: null, workspace: join(dir, "workspace") })).toEqual([join(dir, "workspace")]);
  });

  it("lists a folder once even when the conversation sits in the workspace", () => {
    expect(exportFolders({ downloads, workspace: join(dir, "workspace"), conversation: join(dir, "workspace") }))
      .toEqual([downloads, join(dir, "workspace")]);
    expect(exportFolders({ downloads, workspace: join(dir, "workspace"), configured: join(dir, "workspace"), conversation: join(dir, "task") }))
      .toEqual([downloads, join(dir, "task"), join(dir, "workspace")]);
  });
});

describe("dataExportFolders", () => {
  const folders = () => ({ dataDir: dir, workspace: (id: string) => join(dir, "workspaces", id) });

  it("falls back to the conversation's default task workspace when nothing is pinned or configured", () => {
    expect(dataExportFolders({ id: "bot" }, "thread-1", { ...folders(), taskCwd: () => undefined }))
      .toEqual(machineDownloads([join(dir, "task-workspaces", "bot", "thread-1"), join(dir, "workspaces", "bot")]));
  });

  it("a pinned project folder replaces the configured one, and pinning none drops it", () => {
    expect(dataExportFolders({ id: "bot", cwd: join(dir, "project") }, "thread-1", { ...folders(), taskCwd: () => join(dir, "pinned") }))
      .toEqual(machineDownloads([join(dir, "pinned"), join(dir, "workspaces", "bot")]));
    expect(dataExportFolders({ id: "bot", cwd: join(dir, "project") }, "thread-1", { ...folders(), taskCwd: () => null }))
      .toEqual(machineDownloads([join(dir, "workspaces", "bot")]));
  });

  it("without a conversation, the configured folder stands as before", () => {
    expect(dataExportFolders({ id: "bot", cwd: join(dir, "project") }, undefined, { ...folders(), taskCwd: () => join(dir, "pinned") }))
      .toEqual(machineDownloads([join(dir, "project"), join(dir, "workspaces", "bot")]));
  });
});

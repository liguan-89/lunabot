import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import type { VpsCommandRunner } from "./vps-computer.ts";

const fake = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("./cloud-desktop.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloud-desktop.ts")>(),
  runCommand: fake.runCommand,
}));

import { copyFromComputer, copyToComputer } from "./cloud-computer-files.ts";

const CFG = { vps: { sshAlias: "alpha-vps" } } as AppConfig;
const COMPUTER = "lunabot-vps-bot-a";
const dirs: string[] = [];
const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "" });

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "omb-cloud-files-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  fake.runCommand.mockReset();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("VPS cloud computer file copies", () => {
  it("downloads through docker cp over the bot's SSH alias and lands the file atomically in the folder", async () => {
    const root = folder();
    writeFileSync(join(root, "a.csv"), "old");
    fake.runCommand.mockResolvedValue(ok("3"));
    const copies: string[][] = [];
    const runner: VpsCommandRunner = async (args) => {
      copies.push(args);
      writeFileSync(args.at(-1)!, "new");
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await expect(copyFromComputer(CFG, COMPUTER, root, { path: "/tmp/a.csv" }, new AbortController().signal, { runner }))
      .resolves.toEqual({ path: "a.csv", bytes: 3 });
    expect(readFileSync(join(root, "a.csv"), "utf8")).toBe("new");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.slice(0, 3)).toEqual(["-H", "ssh://alpha-vps", "cp"]);
    expect(copies[0]![3]).toBe(`${COMPUTER}:/tmp/a.csv`);
    expect(copies[0]!.at(-1)).toMatch(/\.a\.csv\.[0-9a-f]+\.part$/);
  });

  it.each([
    ["/etc/passwd", /under \/home\/cua or \/tmp/],
    ["/tmp/../etc/passwd", /under \/home\/cua or \/tmp/],
    ["", /plain Linux path/],
  ])("refuses remote path %s before any VPS command", async (path, message) => {
    const root = folder();
    await expect(copyFromComputer(CFG, COMPUTER, root, { path }, new AbortController().signal))
      .resolves.toEqual({ error: expect.stringMatching(message) });
    expect(fake.runCommand).not.toHaveBeenCalled();
  });

  it.each([
    "../escaped.csv",
    "/tmp/escaped.csv",
    "C:\\escaped.csv",
  ])("refuses local destination %s before asking the VPS for a size", async (to) => {
    const root = folder();
    await expect(copyFromComputer(CFG, COMPUTER, root, { path: "/tmp/a.csv", to }, new AbortController().signal))
      .resolves.toEqual({ error: expect.stringContaining("relative to your working folder") });
    expect(fake.runCommand).not.toHaveBeenCalled();
  });

  it("uploads to a temporary remote file, moves it into place and cleans the temporary copy", async () => {
    const root = folder();
    writeFileSync(join(root, "input.txt"), "payload");
    fake.runCommand.mockImplementation(async (_cfg: unknown, _computer: unknown, command: string) => {
      if (command.startsWith("mkdir -p ") || command.startsWith("mv ") || command.startsWith("rm -f ")) return ok();
      throw new Error(`unexpected remote command: ${command}`);
    });
    const copies: string[][] = [];
    const runner: VpsCommandRunner = async (args) => {
      copies.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await expect(copyToComputer(CFG, COMPUTER, root, { from: "input.txt", path: "data/output.txt" }, new AbortController().signal, { runner }))
      .resolves.toEqual({ path: "/home/cua/data/output.txt", bytes: 7 });
    expect(copies).toHaveLength(1);
    expect(copies[0]!.slice(0, 3)).toEqual(["-H", "ssh://alpha-vps", "cp"]);
    expect(copies[0]![3]).toBe(join(realpathSync(root), "input.txt"));
    expect(copies[0]![4]).toMatch(new RegExp(`^${COMPUTER}:/tmp/lunabot-upload-[0-9a-f]+$`));
    const commands = fake.runCommand.mock.calls.map((call) => call[2] as string);
    expect(commands[0]).toBe("mkdir -p '/home/cua/data'");
    expect(commands[1]).toMatch(/^mv '\/tmp\/lunabot-upload-[0-9a-f]+' '\/home\/cua\/data\/output.txt'$/);
    expect(commands[2]).toMatch(/^rm -f '\/tmp\/lunabot-upload-[0-9a-f]+'$/);
  });

  it.skipIf(process.platform === "win32")("refuses an upload source whose symlink leaves the working folder", async () => {
    const root = folder();
    const outside = folder();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));
    await expect(copyToComputer(CFG, COMPUTER, root, { from: "linked.txt", path: "/tmp/out.txt" }, new AbortController().signal))
      .resolves.toEqual({ error: expect.stringContaining("leads outside your working folder") });
    expect(fake.runCommand).not.toHaveBeenCalled();
  });
});

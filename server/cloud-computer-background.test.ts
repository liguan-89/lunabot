import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppConfig } from "./config.ts";

const fake = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("./cloud-desktop.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloud-desktop.ts")>(),
  runCommand: fake.runCommand,
}));

import {
  backgroundCommandRunning,
  backgroundStatus,
  commandLateText,
  processIdOn,
  startInBackground,
} from "./cloud-computer-background.ts";

const CFG = { vps: { sshAlias: "production-vps" } } as AppConfig;
const COMPUTER = "lunabot-vps-bot-a";
const resultText = (value: unknown) => (value as { content: Array<{ text: string }> }).content[0]!.text;
const resultJson = (value: unknown) => JSON.parse(resultText(value));
const ok = (stdout = "", extra: Record<string, unknown> = {}) => ({ ok: true, exitCode: 0, stdout, stderr: "", ...extra });

beforeEach(() => {
  fake.runCommand.mockReset();
});

describe("VPS cloud computer background commands", () => {
  it("starts an isolated wrapper in the desktop container and returns this computer's tagged process id", async () => {
    fake.runCommand.mockResolvedValue(ok("started"));
    const started = await startInBackground(CFG, COMPUTER, "npm run build", new AbortController().signal);
    const body = resultJson(started);
    expect(body).toMatchObject({ status: "running" });
    expect(body.processId).toMatch(/^bg-[1-9][0-9]{0,15}-[0-9a-f]{8}$/);

    const [cfg, computer, script] = fake.runCommand.mock.calls[0]!;
    expect(cfg).toBe(CFG);
    expect(computer).toBe(COMPUTER);
    expect(script).toContain("nohup");
    expect(script).not.toContain("npm run build");
    const encoded = /printf %s '([^']+)'/.exec(script)?.[1];
    expect(encoded).toBeTruthy();
    const wrapper = Buffer.from(encoded!, "base64").toString("utf8");
    expect(wrapper).toContain("env -i");
    expect(wrapper).toContain("npm run build");
    expect(wrapper).not.toContain("SSH_AUTH_SOCK");

    fake.runCommand.mockResolvedValueOnce(ok("state=finished\nexit_code=0\nstdout_b64=\nstderr_b64=\n"));
    await backgroundStatus(CFG, COMPUTER, { process_id: body.processId }, new AbortController().signal);
  });

  it("refuses another computer's process id without touching the VPS", async () => {
    const status = await backgroundStatus(CFG, "lunabot-vps-bot-b", {
      process_id: processIdOn(COMPUTER, 41),
    }, new AbortController().signal);
    expect((status as { isError?: boolean }).isError).toBe(true);
    expect(resultText(status)).toContain("not from this cloud computer");
    expect(fake.runCommand).not.toHaveBeenCalled();
  });

  it("parses a finished status, bounded output tails and the exit code", async () => {
    const stdout = Buffer.from("build finished").toString("base64");
    const stderr = Buffer.from("warning").toString("base64");
    fake.runCommand.mockResolvedValue(ok(`state=finished\nexit_code=7\nstdout_b64=${stdout}\nstderr_b64=${stderr}\n`));
    const status = await backgroundStatus(CFG, COMPUTER, {
      process_id: processIdOn(COMPUTER, 41),
    }, new AbortController().signal);
    expect(resultJson(status)).toMatchObject({ status: "finished", exitCode: 7, stdout: "build finished", stderr: "warning" });
  });

  it("reports a missing process directory as unknown rather than running it again", async () => {
    fake.runCommand.mockResolvedValue({ ok: false, exitCode: 44, stdout: "", stderr: "" });
    const status = await backgroundStatus(CFG, COMPUTER, {
      process_id: processIdOn(COMPUTER, 41),
    }, new AbortController().signal);
    expect((status as { isError?: boolean }).isError).toBe(true);
    expect(resultText(status)).toContain("no background command with that process_id");
  });

  it("keeps the desktop awake only while a tracked command still runs remotely", async () => {
    fake.runCommand.mockResolvedValueOnce(ok("started"));
    const started = await startInBackground(CFG, COMPUTER, "sleep 30", new AbortController().signal);
    expect(resultJson(started).processId).toBeTruthy();

    fake.runCommand.mockResolvedValueOnce(ok("state=running\nexit_code=\nstdout_b64=\nstderr_b64=\n"));
    await expect(backgroundCommandRunning(CFG, COMPUTER)).resolves.toBe(true);

    fake.runCommand.mockResolvedValueOnce(ok("state=finished\nexit_code=0\nstdout_b64=\nstderr_b64=\n"));
    await expect(backgroundCommandRunning(CFG, COMPUTER)).resolves.toBe(false);
  });

  it("distinguishes a late synchronous exec, background start and status read", () => {
    expect(commandLateText("exec", {})).toContain("may still be running");
    expect(commandLateText("exec", { background: true })).toContain("did not confirm the start");
    expect(commandLateText("exec_status", {})).toContain("call exec_status again");
    expect(commandLateText("screenshot", {})).toBeUndefined();
  });
});

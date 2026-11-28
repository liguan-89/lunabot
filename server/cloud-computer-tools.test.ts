import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  runCommand: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: "captured", stderr: "", timedOut: false })),
  isolatedRemoteCommand: vi.fn((command: string) => `exec env -i ${command}`),
  screenshotCloudComputer: vi.fn(async () => ({ png: "jpeg-data", mime: "image/jpeg" })),
}));

vi.mock("./cloud-desktop.ts", () => ({
  runCommand: remote.runCommand,
  isolatedRemoteCommand: remote.isolatedRemoteCommand,
  screenshotCloudComputer: remote.screenshotCloudComputer,
}));

const tools = await import("./cloud-computer-tools.ts");
const cfg = { vps: { sshAlias: "fixture-vps" } };

function rpc(request: unknown, opts: { boxId?: string | null; held?: boolean } = {}) {
  let gated = 0;
  let checks = 0;
  const done = tools.cloudComputerRpc(request as never, {
    cfg,
    boxId: () => opts.boxId === undefined ? "container-1" : opts.boxId,
    signal: new AbortController().signal,
    gate: async () => { gated++; return { held: opts.held === true, reason: opts.held ? "person" as const : undefined }; },
    assertActive: () => { checks++; },
  });
  return { done, gated: () => gated, checks: () => checks };
}

describe("VPS cloud computer tools", () => {
  beforeEach(() => {
    remote.runCommand.mockClear();
    remote.isolatedRemoteCommand.mockClear();
    remote.screenshotCloudComputer.mockClear();
  });

  it("lists the full computer tool surface without touching the VPS", async () => {
    const listed = await rpc({ method: "tools/list", params: {} }).done as { tools: Array<{ name: string }> };
    expect(listed.tools.map(tool => tool.name)).toEqual([
      "screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec", "exec_status",
      "copy_from_computer", "copy_to_computer",
    ]);
    expect(remote.runCommand).not.toHaveBeenCalled();
    expect(remote.screenshotCloudComputer).not.toHaveBeenCalled();
  });

  it("gates a click once, then runs it on the claimed container through the VPS transport", async () => {
    const call = rpc({ method: "tools/call", params: { name: "click", arguments: { x: 3, y: 4, button: "right", count: 2 } } });
    const result = await call.done as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(call.gated()).toBe(1);
    expect(call.checks()).toBe(2);
    expect(remote.isolatedRemoteCommand).toHaveBeenCalledWith("xdotool mousemove --sync 3 4 click --repeat 2 --delay 100 3");
    expect(remote.runCommand).toHaveBeenCalledWith(cfg, "container-1", "exec env -i xdotool mousemove --sync 3 4 click --repeat 2 --delay 100 3", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("returns native screenshots as MCP images", async () => {
    const result = await rpc({ method: "tools/call", params: { name: "screenshot", arguments: {} } }).done;
    expect(result).toEqual({ content: [{ type: "image", mimeType: "image/jpeg", data: "jpeg-data" }] });
    expect(remote.screenshotCloudComputer).toHaveBeenCalledWith(cfg, "", "container-1", expect.objectContaining({ nativeSize: true }));
  });

  it.each([
    ["click", { x: "1; touch marker", y: 4 }],
    ["open_url", { url: "file:///etc/passwd" }],
    ["move", { x: 1, y: 2, after: "rm -rf /" }],
    ["key_press", { key: "a; reboot" }],
    ["computer_exec", { command: "true" }],
  ])("refuses invalid input before the gate or VPS (%s)", async (name, args) => {
    const call = rpc({ method: "tools/call", params: { name, arguments: args } });
    const result = await call.done as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(call.gated()).toBe(0);
    expect(remote.runCommand).not.toHaveBeenCalled();
  });

  it("a held control or an unclaimed computer acts on nothing", async () => {
    const held = await rpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, { held: true }).done as { isError?: boolean };
    expect(held.isError).toBe(true);
    const unclaimed = await rpc({ method: "tools/call", params: { name: "exec", arguments: { command: "true" } } }, { boxId: null }).done as { isError?: boolean; content: Array<{ text: string }> };
    expect(unclaimed.isError).toBe(true);
    expect(unclaimed.content[0].text).toContain("not ready");
    expect(remote.runCommand).not.toHaveBeenCalled();
  });
});

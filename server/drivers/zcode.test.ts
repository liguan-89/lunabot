// ZCode driver contract tests, run against the scripted fake `zcode
// app-server` in server/testing/fake-zcode-cli.ts: the resume handshake, the
// streaming deltas, model pinning with its reasoning level, the full-access
// requirement, and how a failed run is reported.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { findCliCandidates } from "../env-path.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { decodeZcodeConfig, resolveZcodeLaunch, splitZcodeModel, ZcodeDriver, zcodeExecutable } from "./zcode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-zcode-cli.ts");

describe("splitZcodeModel", () => {
  it("splits provider/model at the first slash", () => {
    expect(splitZcodeModel("opencode-go-messages/deepseek-v4.1-flash")).toEqual({
      providerId: "opencode-go-messages",
      modelId: "deepseek-v4.1-flash",
    });
    expect(splitZcodeModel("account:bigmodel-individual-coding-plan/GLM-5.3-Flash")).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
  });

  it("rejects ids that are not a pair", () => {
    expect(splitZcodeModel("glm-5.3")).toBeNull();
    expect(splitZcodeModel("/model")).toBeNull();
    expect(splitZcodeModel("provider/")).toBeNull();
  });
});

describe("zcodeExecutable", () => {
  const needs = process.platform === "win32" ? it.skip : it;

  it("accepts a bare command name", () => {
    expect(zcodeExecutable("zcode")).toBe("zcode");
  });

  it("accepts an existing absolute file", () => {
    expect(zcodeExecutable(FAKE_CLI)).toBe(FAKE_CLI);
  });

  needs("refuses a target that is not a filesystem executable", () => {
    expect(() => zcodeExecutable("https://example.invalid/zcode")).toThrow(/executable name or an absolute file path/);
    expect(() => zcodeExecutable("/definitely/not/here/zcode")).toThrow(/not a file/);
    expect(() => zcodeExecutable("  ")).toThrow(/executable name or an absolute file path/);
  });
});

describe("resolveZcodeLaunch", () => {
  it("runs a .cjs bundle under node instead of spawning the file", () => {
    const script = join(mkdtempSync(join(tmpdir(), "omb-zcode-launch-")), "zcode.cjs");
    writeFileSync(script, "// zcode bundle\n");
    const launch = resolveZcodeLaunch(script);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([script]);
  });

  it("spawns an executable script directly", () => {
    const launch = resolveZcodeLaunch(FAKE_CLI);
    expect(launch.command).toBe(FAKE_CLI);
    expect(launch.args).toEqual([]);
  });

  it("keeps an unknown bare name so the spawn reports the failure", () => {
    const launch = resolveZcodeLaunch("zcode-definitely-absent");
    expect(launch.command).toBe("zcode-definitely-absent");
  });

  // No `zcode` on PATH but the desktop app present: the bundle is the CLI.
  it.skipIf(
    process.platform !== "darwin" ||
      findCliCandidates("zcode").length > 0 ||
      !existsSync("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
  )("falls back to the desktop app's bundled zcode.cjs", () => {
    const launch = resolveZcodeLaunch("zcode");
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"]);
  });
});

describe("install descriptor", () => {
  it("puts a runnable macOS shim on PATH rather than prose", () => {
    const command = ZcodeDriver.install?.command?.darwin ?? "";
    expect(command).toContain("~/.local/bin/zcode");
    expect(command).toContain("zcode.cjs");
    expect(command).not.toMatch(/^install /);
  });

  // Local machines with the desktop app installed exercise the real command;
  // CI without /Applications/ZCode.app skips it.
  it.skipIf(process.platform !== "darwin" || !existsSync("/Applications/ZCode.app"))(
    "actually prints a version when run",
    () => {
      const home = mkdtempSync(join(tmpdir(), "omb-zcode-install-"));
      const out = execFileSync("/bin/sh", ["-c", ZcodeDriver.install?.command?.darwin ?? ""], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
  );

  it.skipIf(process.platform !== "darwin" || !existsSync("/Applications/ZCode.app"))(
    "reports the engine ready through the bundled CLI alone",
    async () => {
      const instance = await ZcodeDriver.create({
        instanceId: "zcode-bundle",
        displayName: "ZCode",
        environment: {},
        enabled: true,
        config: { cli: "zcode", fullAuto: true },
      });
      try {
        expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
      } finally {
        await instance.dispose();
      }
    },
  );
});

describe("decodeZcodeConfig", () => {
  it("defaults to the PATH CLI and Ask mode", () => {
    expect(decodeZcodeConfig(undefined)).toEqual({ cli: "zcode", fullAuto: false });
    expect(decodeZcodeConfig({ cli: "  ", fullAuto: true })).toEqual({ cli: "zcode", fullAuto: true });
  });

  it("rejects wrong types rather than guessing", () => {
    expect(() => decodeZcodeConfig({ cli: 3 })).toThrow(/cli/);
    expect(() => decodeZcodeConfig({ fullAuto: "yes" })).toThrow(/fullAuto/);
  });
});

describe("ZcodeDriver (fake app-server)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const create = async (mode?: string) => {
    const dump = join(mkdtempSync(join(tmpdir(), "omb-zcode-")), "dump.jsonl");
    instance = await ZcodeDriver.create({
      instanceId: "zcode-test",
      displayName: "ZCode Test",
      environment: { FAKE_ZCODE_DUMP: dump, ...(mode ? { FAKE_ZCODE_MODE: mode } : {}) },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    return {
      dump,
      rows: () =>
        readFileSync(dump, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, any>),
    };
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    recorder = undefined;
    instance = undefined;
  });

  it("normalizes a streaming run into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance!.adapter.sendTurn({
      threadId: "t-happy",
      text: "hi",
      model: "fake/fake-model",
      approvalMode: "full",
    });
    await recorder!.until((event) => event.type === "turn.completed");

    expect(recorder!.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(recorder!.events.every((event) => event.turnId === turnId && event.provider === "zcodeAgent")).toBe(true);

    const text = recorder!.events.find(
      (event) => event.type === "item.completed" && (event as { itemType?: string }).itemType === "assistant_text",
    ) as { text: string };
    expect(text.text).toBe("Hello from zcode");

    expect(recorder!.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: true,
      stopReason: "end_turn",
      usage: { input: 7, output: 3 },
    });
  });

  it("answers the runtime-preferences request the session waits on", async () => {
    const { rows } = await create();
    await instance!.adapter.sendTurn({ threadId: "t-handshake", text: "hi", approvalMode: "full" });
    await recorder!.until((event) => event.type === "turn.completed");
    expect(rows().find((row) => row.id === "server-1")).toEqual({
      reply: { nativeSearchEnhancementsEnabled: false },
      id: "server-1",
    });
  });

  it("pins the model with the reasoning level its catalog publishes", async () => {
    const { rows } = await create();
    await instance!.adapter.sendTurn({ threadId: "t-model", text: "hi", model: "fake/fake-model", approvalMode: "full" });
    await recorder!.until((event) => event.type === "turn.completed");
    expect(rows().find((row) => row.method === "session/setModel")?.params).toEqual({
      sessionId: "sess_fake-1",
      model: { providerId: "fake", modelId: "fake-model", options: { reasoningLevel: "high" } },
    });
    expect(instance!.models.options.map((option) => option.id)).toEqual(["fake/fake-model"]);
  });

  it("hands images to ZCode as typed attachments", async () => {
    const { rows } = await create();
    const image = join(mkdtempSync(join(tmpdir(), "omb-zcode-image-")), "shot.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await instance!.adapter.sendTurn({
      threadId: "t-image",
      text: "what is this",
      images: [{ path: image, mime: "image/png", bytes: 4 }],
      approvalMode: "full",
    });
    await recorder!.until((event) => event.type === "turn.completed");
    expect(rows().find((row) => row.method === "session/send")?.params).toMatchObject({
      content: "what is this",
      // The composer's shape; ZCode drops the resolved `{type, path}` one.
      attachments: [{ kind: "image", localPath: image, filename: "shot.png", mimeType: "image/png", sizeBytes: 4 }],
    });
  });

  it("mounts the turn's MCP servers when it creates the session", async () => {
    const { rows } = await create();
    expect(instance!.adapter.capabilities).toMatchObject({ agentsMcp: true, browserMcp: true, customMcp: true });
    await instance!.adapter.sendTurn({
      threadId: "t-mcp",
      text: "hi",
      approvalMode: "full",
      integrations: { agents: { command: "/bin/echo", args: ["agents"], env: { A: "1" } } },
    });
    await recorder!.until((event) => event.type === "turn.completed");
    const created = rows().filter((row) => row.method === "session/create").at(-1);
    expect(created?.params.mcpServers).toMatchObject([{ name: "agents", command: "/bin/echo", args: ["agents"] }]);
    expect(created?.params.mcpServers[0].env).toContainEqual({ name: "A", value: "1" });
  });

  it("keeps one native session when only MCP credentials rotate", async () => {
    const { rows } = await create();
    const send = async (text: string, token: string) => {
      const { turnId } = await instance!.adapter.sendTurn({
        threadId: "t-mcp-rotate",
        text,
        approvalMode: "full",
        integrations: { agents: { command: "/bin/echo", args: ["agents"], env: { TOKEN: token } } },
      });
      await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    };
    await send("one", "a");
    await send("two", "b");
    const catalogWorkspace = join(DATA_DIR, "providers", "zcode-catalog");
    const creates = rows().filter(
      (row) => row.method === "session/create" && row.params?.workspace?.workspacePath !== catalogWorkspace,
    );
    expect(creates).toHaveLength(1);
  });

  it("lists models before any turn so a bot can be switched onto the engine", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "omb-zcode-catalog-")), "dump.jsonl");
    const fresh = await ZcodeDriver.create({
      instanceId: "zcode-catalog-test",
      displayName: "ZCode Catalog",
      environment: { FAKE_ZCODE_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    try {
      // No sendTurn: the throwaway catalog session is what filled the list.
      expect(fresh.models.options.map((option) => option.id)).toEqual(["fake/fake-model"]);
      const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
      expect(rows.some((row) => row.method === "session/send")).toBe(false);
      // The probe session was closed, not left running.
      expect(rows.some((row) => row.method === "session/close")).toBe(true);
    } finally {
      await fresh.dispose();
    }
  });

  it("resumes the stored session instead of creating a second one", async () => {
    // One dump across both instances, so the second run's frames are visible
    // next to the first run's.
    const dump = join(mkdtempSync(join(tmpdir(), "omb-zcode-resume-")), "dump.jsonl");
    const make = async () => {
      instance = await ZcodeDriver.create({
        instanceId: "zcode-test",
        displayName: "ZCode Test",
        environment: { FAKE_ZCODE_DUMP: dump },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: true },
      });
      recorder = recordEvents(instance.adapter);
    };
    const rows = () =>
      readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);

    await make();
    const first = await instance!.adapter.sendTurn({ threadId: "t-resume", text: "first", approvalMode: "full" });
    await recorder!.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    recorder!.stop();
    await instance!.dispose();

    // A fresh instance has no in-memory session: only the harness cursor.
    await make();
    const second = await instance!.adapter.sendTurn({
      threadId: "t-resume",
      text: "second",
      resumeCursor: "sess_fake-1",
      approvalMode: "full",
    });
    await recorder!.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);

    const session = recorder!.events.find((event) => event.type === "session.started") as { sessionId: string };
    expect(session.sessionId).toBe("sess_fake-1");
    // The catalog probe is its own throwaway workspace; count real threads only.
    const catalogWorkspace = join(DATA_DIR, "providers", "zcode-catalog");
    const realCreates = rows().filter(
      (row) => row.method === "session/create" && row.params?.workspace?.workspacePath !== catalogWorkspace,
    );
    expect(realCreates).toHaveLength(1);
    expect(rows().filter((row) => row.method === "session/resume")).toHaveLength(1);
  });

  it("keeps ZCode's own approval mode and forwards the person's answer", async () => {
    const { rows } = await create("permission");
    await instance!.adapter.sendTurn({ threadId: "t-ask", text: "hi", approvalMode: "ask" });

    const opened = await new Promise<{ requestId: string }>((resolve) => {
      const timer = setInterval(() => {
        const event = recorder!.events.find((candidate) => candidate.type === "request.opened");
        if (event) {
          clearInterval(timer);
          resolve(event as { requestId: string });
        }
      }, 20);
      setTimeout(() => { clearInterval(timer); resolve({ requestId: "" }); }, 5_000);
    });
    expect(opened.requestId).toBe("perm_fake");
    expect(recorder!.events.find((event) => event.type === "request.opened")).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "High risk tools require explicit approval",
    });

    const outcome = await instance!.adapter.respondToRequest("t-ask", "perm_fake", { behavior: "allow" });
    expect(outcome).toBe("allowed-once");
    await recorder!.until((event) => event.type === "turn.completed");

    // The answer is the option's own response object, which is what the child
    // validates; anything else resolves as "Permission request failed".
    expect(rows().find((row) => row.id === "server-perm-1")).toEqual({
      reply: { decision: "allow", reason: "Approved once" },
      id: "server-perm-1",
    });
    expect(recorder!.events.find((event) => event.type === "request.resolved")).toMatchObject({
      requestId: "perm_fake",
      behavior: "allow",
      source: "user",
    });
    // Ask mode keeps zcode in build, where the ask can happen at all.
    expect(rows().find((row) => row.method === "session/setMode")?.params).toEqual({
      sessionId: "sess_fake-1",
      mode: "build",
    });
    expect(recorder!.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("forwards a denial as the deny option's response", async () => {
    const { rows } = await create("permission");
    await instance!.adapter.sendTurn({ threadId: "t-deny", text: "hi", approvalMode: "ask" });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (recorder!.events.some((event) => event.type === "request.opened")) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
      setTimeout(() => { clearInterval(timer); resolve(); }, 5_000);
    });
    expect(await instance!.adapter.respondToRequest("t-deny", "perm_fake", { behavior: "deny" })).toBe("rejected");
    await recorder!.until((event) => event.type === "turn.completed");
    expect(rows().find((row) => row.id === "server-perm-1")).toEqual({
      reply: { decision: "deny", reason: "The user denied this action." },
      id: "server-perm-1",
    });
  });

  it("renders a model question as a card and answers it with the pick", async () => {
    const { rows } = await create("question");
    await instance!.adapter.sendTurn({ threadId: "t-question", text: "pick a color", approvalMode: "ask" });
    const opened = await new Promise<{ requestId: string }>((resolve) => {
      const timer = setInterval(() => {
        const event = recorder!.events.find((candidate) => candidate.type === "request.opened");
        if (event) {
          clearInterval(timer);
          resolve(event as { requestId: string });
        }
      }, 20);
      setTimeout(() => { clearInterval(timer); resolve({ requestId: "" }); }, 5_000);
    });

    expect(opened.requestId).toBe("user-input-1");
    expect(recorder!.events.find((event) => event.type === "request.opened")).toMatchObject({
      requestType: "question",
      tool: "AskUserQuestion",
      summary: "Which color?",
      choices: ["Blue", "Green"],
      questions: [{ question: "Which color?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] }],
    });

    const outcome = await instance!.adapter.respondToRequest("t-question", "user-input-1", {
      behavior: "answer",
      message: "Green",
    });
    expect(outcome).toBe("answered");
    await recorder!.until((event) => event.type === "turn.completed");

    // A question is answered with an accept action keyed by the question text,
    // never with a permission decision.
    expect(rows().find((row) => row.id === "server-q-1")).toEqual({
      reply: { action: "accept", content: { answers: { "Which color?": "Green" } } },
      id: "server-q-1",
    });
    expect(recorder!.events.find((event) => event.type === "request.resolved")).toMatchObject({
      requestId: "user-input-1",
      behavior: "answer",
      source: "user",
    });
  });

  it("declines a question the person dismisses", async () => {
    const { rows } = await create("question");
    await instance!.adapter.sendTurn({ threadId: "t-question-deny", text: "pick a color", approvalMode: "ask" });
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (recorder!.events.some((event) => event.type === "request.opened")) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
      setTimeout(() => { clearInterval(timer); resolve(); }, 5_000);
    });
    expect(await instance!.adapter.respondToRequest("t-question-deny", "user-input-1", { behavior: "deny" })).toBe(
      "rejected",
    );
    await recorder!.until((event) => event.type === "turn.completed");
    expect(rows().find((row) => row.id === "server-q-1")).toEqual({ reply: { action: "decline" }, id: "server-q-1" });
  });

  it("reports a failed run as an error plus an unsuccessful turn", async () => {
    await create("fail");
    await instance!.adapter.sendTurn({ threadId: "t-fail", text: "hi", approvalMode: "full" });
    await recorder!.until((event) => event.type === "turn.completed");
    const error = recorder!.events.find((event) => event.type === "runtime.error") as { message: string };
    expect(error.message).toContain("fake zcode failed");
    expect(recorder!.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "failed" });
  });
});

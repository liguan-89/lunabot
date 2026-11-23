// The agents tool server on a real pi turn, in an isolated fixture: the saved switch reaches the
// proxy a turn is launched with, that proxy lists the whole catalog with the turn's capability,
// and every gate the harness keeps (a tool selection, a Chief-only tool, the per-turn thread
// limit) holds. pi refuses the find_tool/use_tool bridge itself (agents-bridge-switch.ts: its own
// extensions can block a tool by the name they see), so this recipe proves the switch never
// bridges a pi turn and there is no bridged mount to talk to.
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireMessage } from "../shared/wire.ts";
import { type BridgeTool } from "./drivers/agents-bridge.ts";
import { AGENTS_TOOL_BRIDGE_PROMPT } from "./system-prompt.ts";
import { turnEvidence } from "./turn-outcome.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { childEnv } from "./testing/omb-env.ts";
import { piDumpPath, piInstructionsFor, piTurns, piTurnText, type PiTurn } from "./testing/pi-dump.ts";

type McpServer = { command: string; args: string[]; env: Record<string, string> };
/** What the fake pi was launched with, and the turn it was given. */
type Launched = {
  systemPrompt: string;
  prompt: string;
  mcpConfig: { mcpServers: Record<string, McpServer> };
};

/** The conversation a turn ran on: a tool selection puts the agents server behind a gate, whose
 * upstream copy carries the identity. */
const threadOf = (turn: PiTurn): string | undefined => {
  const env = turn.launch?.mcpConfig?.mcpServers?.agents?.env;
  if (env?.LUNABOT_THREAD_ID) return env.LUNABOT_THREAD_ID;
  try {
    return env?.LUNABOT_GATE_UPSTREAM ? (JSON.parse(env.LUNABOT_GATE_UPSTREAM) as { env?: { LUNABOT_THREAD_ID?: string } }).env?.LUNABOT_THREAD_ID : undefined;
  } catch {
    return undefined;
  }
};
type Answer = {
  id: number;
  result?: { tools?: BridgeTool[]; content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
};
type Ask = (method: string, params?: unknown) => Promise<Answer>;

async function withFixture(run: (helpers: {
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  control(args: string[]): Promise<any>;
  /** The pi launch and prompt of the turn just sent: pi holds it open on FAKE_PI_HOLD_ON. With a
   * threadId it waits for that conversation's turn, since a fixture can have more than one bot. */
  launched(threadId?: string): Promise<Launched>;
  // hang: the engine keeps its turn open until it is interrupted
}) => Promise<void>, engine: Record<string, string> = { FAKE_PI_HOLD_ON: "Stay active" }) {
  const fixture = await launchVerificationServer({ ...process.env, ...engine });
  const dumpPath = piDumpPath(fixture.info.dataDir);
  let seen = 0;
  try {
    await run({
      api: async (method, path, body) => {
        const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      },
      control: (args) => runControlOmb([...args, "--url", fixture.info.url]),
      launched: async (threadId) => {
        let index = -1;
        await expect.poll(() => {
          const turns = piTurns(dumpPath);
          index = turns.findLastIndex((turn, at) => at >= seen && (!threadId || threadOf(turn) === threadId));
          return index >= 0;
        }, { timeout: 30_000 }).toBe(true);
        const turns = piTurns(dumpPath);
        seen = turns.length;
        const launch = turns[index]!.launch;
        expect(launch, "the fake pi launch behind this turn").toBeTruthy();
        return {
          systemPrompt: piInstructionsFor(turns, index),
          prompt: piTurnText(turns[index]!),
          mcpConfig: { mcpServers: (launch!.mcpConfig?.mcpServers ?? {}) as Record<string, McpServer> },
        };
      },
    });
  } finally { await fixture.close(); }
}

/** One MCP server exactly as the engine was told to start it, asked one
 * request at a time: each answer is read off its stdout before the next
 * request is written, as an engine's own calls arrive, so a limit the
 * harness counts is counted in the order asked. */
async function withServer(server: McpServer, run: (ask: Ask) => Promise<void>): Promise<void> {
  const child = spawn(server.command, server.args, { env: childEnv(server.env), stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, { resolve(answer: Answer): void; reject(error: Error): void }>();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const answer = JSON.parse(buffer.slice(0, newline)) as Answer;
      buffer = buffer.slice(newline + 1);
      waiting.get(answer.id)?.resolve(answer);
      waiting.delete(answer.id);
    }
  });
  const stopped = (why: string) => { for (const entry of waiting.values()) entry.reject(new Error(why)); waiting.clear(); };
  child.on("error", (error) => stopped(String(error)));
  child.on("exit", (code) => stopped(`the agents server exited (${code}) before answering`));
  try {
    await run((method, params) => new Promise<Answer>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    }));
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

const namesOf = (answer: Answer) => answer.result!.tools!.map((tool) => tool.name);
const textOf = (answer: Answer) => answer.result!.content![0]!.text;
const call = (ask: Ask, name: string, args: unknown) => ask("tools/call", { name, arguments: args });
const use = (ask: Ask, name: string, args?: unknown) => call(ask, "use_tool", { name, ...(args === undefined ? {} : { arguments: args }) });
/** A bridged call that was refused: a failed tool call the model reads,
 * never a protocol error, and its words. */
const refusalOf = (answer: Answer): string => {
  expect(answer.error).toBeUndefined();
  expect(answer.result!.isError).toBe(true);
  return textOf(answer);
};

it("keeps a pi turn on the whole catalog whether the switch is on or off, in a chat and in a room", async () => {
  await withFixture(async ({ api, control, launched }) => {
    const { bot } = await control(["new-bot", "--name", "Bridge fixture"]);
    const { bot: teammate } = await control(["new-bot", "--name", "Bridge teammate"]);

    // Off by default: the whole catalog, no bridge tools, nothing in the prompt.
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    const before = await launched(bot.activeTaskId);
    const agents = before.mcpConfig.mcpServers.agents!;
    expect(agents.env.LUNABOT_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(before.systemPrompt).not.toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    expect(before.prompt).toContain("Stay active.");
    await withServer(agents, async (ask) => {
      const whole = (await ask("tools/list")).result!.tools!;
      expect(whole.map((tool) => tool.name)).toEqual(expect.arrayContaining(["coordinate_bots", "trigger", "trigger_info", "session_search"]));
      expect(whole.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["find_tool"]));
      expect(whole.length).toBeGreaterThan(25);
      // the bridge's two names mean nothing to a turn that does not have it
      expect((await call(ask, "use_tool", { name: "list_triggers" })).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
      expect((await call(ask, "find_tool", { query: "routines" })).error).toEqual({ code: -32602, message: "Unknown tool: find_tool" });
      // the catalog really answers, and a Chief-only parameter is refused by the harness
      expect(textOf(await call(ask, "list_triggers", {}))).toMatch(/^This bot has no triggers\. Current time: /);
      expect((await call(ask, "create_bot", { name: "Scout", role: "Ops", instructions: "Work." })).error)
        .toEqual({ code: -32602, message: "Unknown tool: create_bot" });
      const refused = await call(ask, "propose_profile", { title: "Lead", reason: "asked", for_bot_id: teammate.id });
      expect(refusalOf(refused)).toContain("only a section's Chief of Staff can change another bot's profile");
    });
    await control(["interrupt", "--bot", bot.id]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);

    // Switched on in the saved settings: pi still refuses the bridge (its own extensions can block
    // a tool by the name they see), so the next launch keeps the whole catalog and the prompt says
    // nothing about find_tool/use_tool. A bridged mount and its smaller list no longer exist to test.
    expect((await api("PATCH", "/api/config", { features: { agentsToolBridge: true } })).status).toBe(200);
    await control(["send", "--bot", bot.id, "--text", "Stay active again."]);
    const after = await launched(bot.activeTaskId);
    expect(after.mcpConfig.mcpServers.agents!.env.LUNABOT_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(after.systemPrompt).not.toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    // the rest of the prompt still names its tools as it did
    for (const prompt of [before.systemPrompt, after.systemPrompt]) expect(prompt).toContain("set it up with trigger action=create in this turn");
    // a fixture bot is not a Chief of Staff, so create_bot is not one of its tools
    expect(after.mcpConfig.mcpServers.agents!.env.LUNABOT_CHIEF_OF_STAFF).toBe("0");
    await control(["interrupt", "--bot", bot.id]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);

    // A room turn is built by its own code path; it gets the same refusal.
    const { channel } = await control(["new-channel", "--name", "Bridge room", "--members", bot.id]);
    await control(["send-channel", "--channel", channel.id, "--text", "Stay active in this room."]);
    const room = await launched(channel.activeTaskId);
    expect(room.mcpConfig.mcpServers.agents!.env.LUNABOT_AGENTS_TOOL_BRIDGE).toBe("0");
    // A room refuses widgets, pages and a computer pick, so its turn is not listed them.
    expect(room.mcpConfig.mcpServers.agents!.env).toMatchObject({ LUNABOT_ROOM: "1", LUNABOT_COMPUTER_SELECTION: "0" });
    expect(after.mcpConfig.mcpServers.agents!.env.LUNABOT_ROOM).toBe("0");
    expect(room.systemPrompt).not.toContain(AGENTS_TOOL_BRIDGE_PROMPT);
    await control(["interrupt", "--channel", channel.id]);
    await control(["wait", "--channel", channel.id, "--timeout", "30"]);
  });
}, hostTimeout(90_000));

it("leaves every gate and limit where it was: a tool selection, a Chief-only tool and the per-turn thread limit hold on pi", async () => {
  await withFixture(async ({ api, control, launched }) => {
    // Even with the bridge switch on, pi's turns stay unbridged; these gates are the ones that matter.
    expect((await api("PATCH", "/api/config", { features: { agentsToolBridge: true } })).status).toBe(200);

    // A bot with a tool selection keeps the whole catalog behind its gate,
    // which refuses the excluded tool by its own name; there is no bridge to
    // carry the call past it.
    const { bot: selected } = await control(["new-bot", "--name", "Selected bridge fixture"]);
    const toolScope = { deny: ["mcp:agents:vm_exec"] };
    expect((await api("PATCH", `/api/bots/${selected.id}`, { toolScope })).status).toBe(200);
    await control(["send", "--bot", selected.id, "--text", "Stay active."]);
    const gatedTurn = await launched(selected.activeTaskId);
    // With a selection the engine is handed the gate, which starts the proxy.
    const gate = gatedTurn.mcpConfig.mcpServers.agents!;
    expect(JSON.parse(gate.env.LUNABOT_GATE_TOOL_SCOPE!)).toEqual(toolScope);
    expect((JSON.parse(gate.env.LUNABOT_GATE_UPSTREAM!) as McpServer).env.LUNABOT_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(gatedTurn.systemPrompt).not.toContain("find_tool");
    await withServer(gate, async (ask) => {
      const list = await ask("tools/list");
      // the whole catalog but the one tool the selection leaves out, and no way round it
      expect(namesOf(list)).toEqual(expect.arrayContaining(["coordinate_bots", "trigger", "list_rooms", "post_to_room"]));
      for (const name of ["vm_exec", "find_tool", "use_tool"]) expect(namesOf(list), name).not.toContain(name);
      expect((await call(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "vm_exec", { command: "true" })).error).toEqual({ code: -32602, message: "Tool selection excludes this tool. Check the bot's Access settings." });
      expect((await use(ask, "list_triggers")).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
    });
    await control(["interrupt", "--bot", selected.id]);
    await control(["wait", "--bot", selected.id, "--timeout", "30"]);

    // A bot with no selection is not bridged either: pi refuses the bridge.
    const { bot } = await control(["new-bot", "--name", "Limits bridge fixture"]);
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    const turn = await launched(bot.activeTaskId);
    const agents = turn.mcpConfig.mcpServers.agents!;
    expect(agents.env.LUNABOT_AGENTS_TOOL_BRIDGE).toBe("0");
    expect(agents.env.LUNABOT_BOT_ID).toBe(bot.id);
    expect(turn.systemPrompt).not.toContain(AGENTS_TOOL_BRIDGE_PROMPT);

    // The harness refuses a Chief-only tool to this bot whatever its proxy
    // lists. Started as if it were a Chief's, the proxy lets the call
    // through, and the harness's own refusal comes back.
    await withServer({ ...agents, env: { ...agents.env, LUNABOT_CHIEF_OF_STAFF: "1" } }, async (ask) => {
      const scout = { name: "Scout", role: "Ops", instructions: "Work." };
      const direct = await call(ask, "create_bot", scout);
      expect(refusalOf(direct)).toContain("only a section's Chief of Staff can create operator bots");
      expect((await use(ask, "create_bot", scout)).error).toEqual({ code: -32602, message: "Unknown tool: use_tool" });
    });

    // One count for the turn, kept by the harness: the sixth thread is refused
    // in the same words a bridged call used to get.
    await withServer(agents, async (ask) => {
      const job = (n: number) => ({ title: `Bridge job ${n}`, message: `Do job ${n}.` });
      for (const n of [1, 2, 3, 4, 5]) {
        const opened = await call(ask, "start_thread", job(n));
        expect(opened.result!.isError, `direct ${n}`).toBeFalsy();
        expect(textOf(opened)).toContain(`Opened thread #Bridge job ${n} on yourself`);
      }
      expect(refusalOf(await call(ask, "start_thread", job(6)))).toContain("You have already opened 5 threads this turn, which is the limit");
    });
    await control(["interrupt", "--bot", bot.id]);
  });
}, hostTimeout(120_000));

it("keeps a pi turn's rows and work summary under the name the engine reported, with no bridge renaming", async () => {
  // What pi reports for a turn whose calls are named use_tool/find_tool. pi never bridges, so the
  // rows must keep those names even though the switch is off and one call names a catalog tool.
  // The bridged-name half of this recipe (use_tool renamed to the tool it ran) is gone with the
  // engine that could bridge; pi refuses it.
  const calls = [
    { name: "mcp__agents__use_tool", input: { name: "list_triggers", arguments: {} }, output: "This bot has no triggers.", ok: true },
    { name: "mcp__agents__use_tool", input: { name: "post_to_room", arguments: { group_id: "room-1", message: "Shipped." } }, output: "Posted.", ok: true },
    { name: "mcp__agents__use_tool", input: { name: "schedule_task", arguments: {} }, output: "Unknown tool: schedule_task", ok: false },
    { name: "mcp__agents__use_tool", input: { arguments: { name: "vm_exec" } }, output: "use_tool needs a name", ok: false },
    { name: "mcp__agents__find_tool", input: { query: "what routines do I have" }, output: "{}", ok: true },
    { name: "mcp__agents__list_bots", input: {}, output: "No other bots.", ok: true },
  ];
  await withFixture(async ({ api, control }) => {
    const { bot } = await control(["new-bot", "--name", "Bridge names fixture"]);
    /** One turn's tool rows and its work summary. */
    const turn = async (text: string) => {
      await control(["send", "--bot", bot.id, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--timeout", "30"])).status).toBe("settled");
      const { messages } = (await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).body as { messages: WireMessage[] };
      const latest = messages.findLast((message) => message.kind === "digest")!;
      return { rows: messages.filter((message) => message.kind === "activity" && message.tool?.itemId && message.turnId === latest.turnId), digest: latest.digest! };
    };

    // This turn's agents server lists its whole catalog, so a tool called use_tool is not the
    // bridge's, whatever it names. Every row keeps the name it came with.
    const unbridged = await turn("Use your tools.");
    expect(unbridged.rows.map((row) => row.tool!.name)).toEqual(calls.map((call) => call.name));
    expect(Object.fromEntries(unbridged.digest.tools.map((tool) => [tool.name, tool.count]))).toEqual({
      "mcp__agents__use_tool": 4,
      "mcp__agents__find_tool": 1,
      "mcp__agents__list_bots": 1,
    });
    // nothing was renamed into an outward-looking catalog name, so the restart policy sees none
    expect(turnEvidence(unbridged.rows as never)).not.toHaveProperty("outward");

    // The bot's Activity log is read back from the event log after the fact. A title that names the
    // agents server reads as the tool its arguments named, so the two calls that carried a catalog
    // name appear as that tool; what named none, or no catalog tool, stays a use_tool call.
    const { rows } = (await api("GET", `/api/bots/${bot.id}/activity`)).body as { rows: Array<{ tool: string; app: string | null; label: string; outcome: string }> };
    const logged = (tool: string) => rows.filter((row) => row.tool === tool).map(({ app, label, outcome }) => ({ app, label, outcome }));
    expect(logged("mcp__agents__list_triggers")).toEqual([{ app: "Team", label: "List triggers", outcome: "ran" }]);
    expect(logged("mcp__agents__post_to_room")).toEqual([{ app: "Team", label: "Post to room", outcome: "ran" }]);
    expect(logged("mcp__agents__use_tool")).toEqual([
      { app: "Team", label: "Use tool", outcome: "failed" },
      { app: "Team", label: "Use tool", outcome: "failed" },
    ]);
    expect(logged("mcp__agents__find_tool")).toEqual([{ app: "Team", label: "Find tool", outcome: "ran" }]);
    expect(logged("mcp__agents__list_bots")).toEqual([{ app: "Team", label: "List bots", outcome: "ran" }]);
  }, { FAKE_PI_CLAUDE_COMPAT: "1", FAKE_PI_TOOL_CALLS: JSON.stringify(calls) });
}, hostTimeout(90_000));

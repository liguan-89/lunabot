#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface for pi.ts tests. Env knobs:
//   FAKE_PI_MODE  happy (default) | tooluse | priced | priced-stop | permission | interleave | question-select | question-input
//     | turn-error | no-models | exit-early | compaction | compaction-recovery
//     | compaction-recovery-upstream | prompt-reject | omp-chunk
//     | session-slow (answers new_session after FAKE_PI_SESSION_DELAY_MS, default 800, and dumps {sessionReplied})
//   FAKE_PI_MODELS  provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_DUMP  path to append {argv, env} JSON to
//   FAKE_PI_STEER_REFUSE  answer a steer with an explicit success:false
//   FAKE_PI_STEER_OUT_OF_ORDER  hold the first steer until a second arrives, then refuse the first and accept the second

import { appendFileSync, readFileSync } from "node:fs";

import piMcpExtension from "../drivers/pi-mcp-extension.ts";
import { TURN_CLOCK_LEAD } from "../turn-clock.ts";
import { ownTurnText, runRoomHandoffAgent, type AgentsIntegration } from "./room-handoff-agent.ts";

const claudeCompat = process.env.FAKE_PI_CLAUDE_COMPAT === "1";
const mode = process.env.FAKE_PI_MODE ?? "happy";
const modelPairs = (process.env.FAKE_PI_MODELS ?? "ollama-cloud/glm-5.2,openai/gpt-4o")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [provider, id] = pair.split("/");
    return { provider: provider ?? "x", id: id ?? "m", name: id ?? "m" };
  });

const argv = process.argv.slice(2);

interface MountedTool {
  name: string;
  label?: string;
  invoke(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: unknown): Promise<unknown>;
}

interface RegisteredTool {
  name: string;
  label?: string;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: unknown): Promise<unknown>;
}

/** Mount the turn's MCP servers through the real pi extension, as the real pi process would. The plan runner then
 * calls their tools through the same client, so a scripted step exercises the actual extension and agents proxy. */
async function mountMcpTools(): Promise<MountedTool[]> {
  const tools: MountedTool[] = [];
  try {
    await piMcpExtension({
      registerTool: (definition: RegisteredTool) => {
        tools.push({ name: definition.name, label: definition.label, invoke: definition.execute });
      },
      on: () => {},
    });
    return tools;
  } catch (error) {
    process.stderr.write(`[fake-pi] mounting MCP tools failed: ${String((error as Error)?.message ?? error)}\n`);
    return tools;
  }
}

const mountedTools = process.env.FAKE_PI_ROOM_PLAN && !argv.includes("--version") && !argv.includes("-v") ? await mountMcpTools() : [];
let planStep = 0;
const uiWaiters = new Map<string, (value: string | undefined) => void>();
let uiSeq = 0;

/** A plan's ask_user runs through pi's native question card, as the real extension does. */
function askUi(method: "select" | "input", title: string, options?: string[]): Promise<string | undefined> {
  const id = `plan-ui-${++uiSeq}`;
  return new Promise((resolve) => {
    uiWaiters.set(id, resolve);
    send({ type: "extension_ui_request", id, method, title, ...(options ? { options } : {}) });
  });
}

/** Plan scripts speak the retired ask card's {question, choices}; pi's ask_user takes a questions array. */
function askArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const legacy = args as { question?: unknown; choices?: unknown };
  if (typeof legacy.question !== "string") return args;
  const labels = Array.isArray(legacy.choices) ? legacy.choices.filter((choice): choice is string => typeof choice === "string") : [];
  return { questions: [{ question: legacy.question, ...(labels.length ? { options: labels.map((label) => ({ label })) } : {}) }] };
}

async function callMountedTool(name: string, args: unknown): Promise<unknown> {
  const tool = mountedTools.find((candidate) => candidate.label === `agents:${name}` || candidate.name === name || candidate.name.endsWith(`_${name}`));
  if (!tool) throw new Error(`the pi fixture mounted no agents tool named ${name}`);
  return tool.invoke(`plan-${++planStep}`, name === "ask_user" ? askArgs(args) : args, undefined, undefined, {
    ui: {
      confirm: async () => true,
      select: (title: string, options: string[]) => askUi("select", title, options),
      input: (title: string) => askUi("input", title),
    },
  });
}

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("pi 0.84.2 (fake)\n");
  process.exit(0);
}

if (process.env.FAKE_PI_DUMP) {
  try {
    // Read OMB_MCP_CONFIG now: the driver deletes the temp file when the turn settles.
    let mcpConfig: unknown = null;
    if (process.env.OMB_MCP_CONFIG) {
      try {
        mcpConfig = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8"));
      } catch {}
    }
    appendFileSync(
      process.env.FAKE_PI_DUMP,
      JSON.stringify({
        argv,
        envConfigured: ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "BOX_TOKEN"].filter(
          (k) => process.env[k] !== undefined,
        ),
        mcpConfig,
      }) + "\n",
    );
  } catch {}
}

if (argv[0] === "update" && argv.includes("--models")) {
  process.exit(mode === "update-error" ? 1 : 0);
}

if (mode === "exit-early") {
  process.exit(1);
}

if (claudeCompat && process.env.FAKE_CLAUDE_MODE === "exit-early") {
  process.exit(1);
}

const send = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
// omp's RPC v2: the runtime announces v1 with a 1 MiB frame cap and stubs bigger responses unless the
// client negotiated protocol 2; v2 sends them as `rpc_chunk` frames to reassemble.
const ompChunkMode = mode === "omp-chunk";
let negotiatedV2 = false;
let chunkSeq = 0;
const sendChunked = (frame: any) => {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const size = Math.ceil(bytes.length / 3);
  const count = Math.max(2, Math.ceil(bytes.length / size));
  const chunkId = `rpc-${++chunkSeq}`;
  for (let index = 0; index < count; index++) {
    send({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
    });
  }
};
if (ompChunkMode) {
  send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
let sessionCounter = 0;
let currentSessionFile: string | null = null;
const heldSteerFrames: any[] = [];

const streamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const delta of ["Hello", " from", " pi"]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

// Un-negotiated, the v1 transport replaces each chunked frame with the `rpc_frame_error` stub.
const streamChunkedTurn = () => {
  for (const frame of [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " from" } },
    { type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " pi" } },
    { type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } },
    { type: "agent_end" },
  ]) {
    if (negotiatedV2) sendChunked(frame);
    else send({ type: "rpc_frame_error", originalType: frame.type, error: "RPC frame exceeded the transport limit" });
  }
  setTimeout(() => process.exit(0), 50);
};

const streamErrorTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({
    type: "turn_end",
    message: {
      stopReason: "error",
      errorMessage: "Invalid schema for function 'computer_browser_prepare'",
      usage: { input: 0, output: 0 },
    },
    usage: { input: 0, output: 0 },
  });
  send({ type: "agent_end" });
};

const streamCompactionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before" } });
  // A failed attempt (pi reports it with errorMessage, not aborted) and a skipped one (no result, no error, e.g. an
  // expired credential); FAKE_PI_COMPACTION_FAILS_ONLY=1 stops there, otherwise one attempt succeeds with a summary.
  send({ type: "compaction_start", reason: "threshold" });
  send({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed" });
  send({ type: "compaction_start", reason: "threshold" });
  send({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  // An extension can also hand back a result with an empty or non-text summary: nothing usable was made, so no marker either.
  send({ type: "compaction_start", reason: "threshold" });
  send({ type: "compaction_end", reason: "threshold", result: { summary: " ", firstKeptEntryId: "e1", tokensBefore: 100 }, aborted: false, willRetry: false });
  send({ type: "compaction_end", reason: "threshold", result: { summary: {}, firstKeptEntryId: "e1", tokensBefore: 100 }, aborted: false, willRetry: false });
  if (process.env.FAKE_PI_COMPACTION_FAILS_ONLY !== "1") {
    send({ type: "compaction_start", reason: "threshold" });
    send({ type: "compaction_end", reason: "threshold", result: { summary: "fake summary", firstKeptEntryId: "e1", tokensBefore: 100 }, aborted: false, willRetry: false });
  }
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "compacted" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

// Post-run overflow recovery: turn_end and a non-terminal agent_end, compaction, one more turn, then the terminal agent_end.
const streamCompactionRecoveryTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end", isTerminal: false });
  setTimeout(() => {
    send({ type: "compaction_start", reason: "overflow" });
    send({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
    send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 4, output: 1 } }, usage: { input: 4, output: 1 } });
    send({ type: "agent_end", isTerminal: true });
  }, 30);
};

// The same in upstream pi's dialect: willRetry instead of isTerminal, closing with agent_settled.
const streamCompactionRecoveryUpstreamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end", willRetry: true });
  setTimeout(() => {
    send({ type: "compaction_start", reason: "overflow" });
    send({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
    send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 4, output: 1 } }, usage: { input: 4, output: 1 } });
    send({ type: "agent_end", willRetry: false });
    send({ type: "agent_settled" });
  }, 30);
};

const streamToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi", password: "pi-input-secret" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }], api_key: "pi-output-secret" } });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 2 } }, usage: { input: 12, output: 2 } });
  send({ type: "agent_end" });
};

// pi's real Usage shape (pi-ai): cached tokens and the priced cost ride on message.usage, not a top-level usage.
const piUsage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

// Like pi, the assistant message_end carries the call's usage before its tool runs; turn_end repeats it.
const startPricedToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: piUsage(5, 1, 100, 20, 0.0021) } });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
};

const streamPricedTurn = () => {
  startPricedToolTurn();
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }] } });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: piUsage(5, 1, 100, 20, 0.0021) } });
  send({ type: "turn_start" });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  send({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: piUsage(12, 2, 120, 0, 0.0004) } });
  send({ type: "turn_end", message: { stopReason: "stop", usage: piUsage(12, 2, 120, 0, 0.0004) } });
  send({ type: "agent_end" });
};

const streamPermissionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Run bash: echo hi?", options: ["Allow once", "Deny"] });
};

const streamQuestionSelectTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-select", method: "select", title: "Which color?",
    options: process.env.FAKE_PI_QUESTION_OPTIONS ? JSON.parse(process.env.FAKE_PI_QUESTION_OPTIONS) : ["Blue", "Green"] });
};

const streamQuestionInputTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "extension_ui_request", id: "ask-input", method: "input", title: "Which city?" });
};

const streamInterleaveTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before one" } });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo one" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before two" } });
  send({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "echo two" } });
  send({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 12, output: 3 } }, usage: { input: 12, output: 3 } });
  send({ type: "agent_end" });
};

const finishPermissionTurn = () => {
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage: { input: 8, output: 1 } }, usage: { input: 8, output: 1 } });
  send({ type: "agent_end" });
};

// A retired-Claude-fixture bridge: same reply/tool/mode knobs, rendered as pi RPC events.
let compatReplyIndex = 0;

const compatReplies = (() => {
  try {
    const parsed = JSON.parse(process.env.FAKE_CLAUDE_REPLIES ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();

function compatReply(): string[] {
  const reply = compatReplies[compatReplyIndex++];
  if (Array.isArray(reply)) return reply.map(String);
  if (typeof reply === "string") return [reply];
  return ["hello from fake claude"];
}

function compatToolCalls(): Array<{ name: string; input: Record<string, unknown>; ok: boolean }> {
  try {
    const parsed = JSON.parse(process.env.FAKE_CLAUDE_TOOL_CALLS ?? "");
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object")
        .map((call) => ({ name: String(call.name ?? "Bash"), input: (call.input as Record<string, unknown>) ?? {}, ok: call.ok !== false }));
    }
  } catch {}
  return [{ name: "Bash", input: { command: "echo hi" }, ok: true }];
}

function finishCompatTurn(replies: string[]): void {
  const text = replies.join("\n");
  const context = Number(process.env.FAKE_PI_CONTEXT_TOKENS ?? process.env.FAKE_CLAUDE_CONTEXT_TOKENS);
  const usage = Number.isSafeInteger(context) && context > 0 ? { input: context, output: 3 } : { input: 12, output: 3 };
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  send({ type: "turn_end", message: { stopReason: "end_turn", usage }, usage });
  send({ type: "agent_end", isTerminal: true });
}

let turnAborted = false;
/** pi sends the system prompt only on a session's first turn; keep it so evidence reads like a launched session. */
let roomSystemPrompt: string | null = null;

/** The identity the drivers give a pi child, in the same shape the room plan runner reads from an agents server.
 * The runner starts that command for a direct MCP path; this turn runs its steps through the mounted tools instead,
 * so the process only has to stay alive until the turn settles. */
function roomIntegration(): AgentsIntegration {
  const env: Record<string, string> = { OMB_COMMS_TOKEN: "fixture" };
  if (process.env.OMB_BOT_ID) env.OMB_BOT_ID = process.env.OMB_BOT_ID;
  if (process.env.OMB_THREAD_ID) env.OMB_THREAD_ID = process.env.OMB_THREAD_ID;
  return { command: process.execPath, args: ["-e", "setInterval(() => {}, 1_000)"], env };
}

function streamRoomTurn(message: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  const integration = roomIntegration();
  // The time line leads each turn's own text; the words before it are the system prompt on a session's first
  // turn, or the volatile-context note that replaced part of it on a later one. Either is what the model reads now.
  const clockAt = message.indexOf(TURN_CLOCK_LEAD);
  const prefix = clockAt >= 0 ? message.slice(0, clockAt).trimEnd() : "";
  if (prefix) roomSystemPrompt = prefix;
  const text = clockAt >= 0 ? message.slice(clockAt) : message;
  const system = roomSystemPrompt ?? message;
  void runRoomHandoffAgent([], process.env.FAKE_PI_ROOM_PLAN!, { message: { content: text } },
    { integration, system },
    (progress) => {
      if (turnAborted) return;
      send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: progress } });
    },
    () => [],
    {
      integration,
      system,
      ownText: ownTurnText({ message: { content: text } }),
      context: message,
      tools: mountedTools.map((tool) => tool.label?.split(":").at(-1) ?? tool.name),
      callTool: (name, args) => callMountedTool(name, args),
      onToolStart: (trace) => send({ type: "tool_execution_start", toolCallId: trace.id, toolName: trace.name, args: trace.args }),
      onToolEnd: (trace) => send({ type: "tool_execution_end", toolCallId: trace.id, toolName: trace.name, isError: !trace.ok, result: trace.result }),
    }).then((reply) => {
      if (turnAborted) return;
      finishCompatTurn([reply]);
    }).catch((error) => {
      if (turnAborted) return;
      send({ type: "turn_end", message: { stopReason: "error", errorMessage: String(error) }, usage: { input: 0, output: 0 } });
      send({ type: "agent_end", isTerminal: true });
    });
}

/** A held turn says nothing (or one partial line) until the person stops it. */
function holdTurn(partial?: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  if (partial) {
    send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial } });
  }
  setInterval(() => {}, 1_000);
}

function delayTurn(message: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  setTimeout(() => {
    if (!turnAborted) finishCompatTurn([`echo: ${message}`]);
  }, Number(process.env.FAKE_PI_DELAY_MS ?? 1_200));
}

function compatPrompt(): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  for (const [index, call] of compatToolCalls().entries()) {
    const id = `compat-${index}`;
    send({ type: "tool_execution_start", toolCallId: id, toolName: call.name, args: call.input });
    send({ type: "tool_execution_end", toolCallId: id, toolName: call.name, isError: !call.ok, result: { content: [{ type: "text", text: call.ok ? "ok" : "failed" }] } });
  }
  const replies = compatReply();
  if (process.env.FAKE_CLAUDE_MODE === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  finishCompatTurn(replies);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(cmd: any) {
  switch (cmd.type) {
    case "negotiate_protocol":
      // Vanilla pi 1.0.2 refuses the unknown command and keeps working.
      if (!ompChunkMode) {
        send({ id: cmd.id, type: "response", command: "negotiate_protocol", success: false, error: "Unknown command: negotiate_protocol" });
        return;
      }
      if (cmd.protocolVersion === 2) {
        negotiatedV2 = true;
        send({ type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      } else {
        send({ type: "response", command: "negotiate_protocol", success: false, error: "fake pi: only protocol version 2 is supported" });
      }
      return;
    case "get_available_models": {
      const response = {
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: mode === "no-models" ? [] : modelPairs },
      };
      if (ompChunkMode && !negotiatedV2) {
        send({ type: "response", command: "get_available_models", success: false, error: "RPC response exceeded the transport limit" });
        return;
      }
      if (ompChunkMode) sendChunked(response);
      else send(response);
      return;
    }
    case "get_state":
      send({ type: "response", command: "get_state", success: true, data: {
        model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false,
        steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", sessionFile: currentSessionFile,
        sessionId: `s-${sessionCounter}`, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
      } });
      return;
    case "new_session":
      if (mode === "session-error") {
        send({ type: "response", command: "new_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      sessionCounter += 1;
      currentSessionFile = `/fake/pi-session-${sessionCounter}.json`;
      if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ newSession: true }) + "\n");
      const sessionReply = { type: "response", command: "new_session", success: true, data: { sessionId: `s-${sessionCounter}`, sessionFile: currentSessionFile } };
      if (mode !== "session-slow") {
        send(sessionReply);
        return;
      }
      setTimeout(() => {
        if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ sessionReplied: true }) + "\n");
        send(sessionReply);
      }, Number(process.env.FAKE_PI_SESSION_DELAY_MS ?? 800));
      return;
    case "switch_session":
      if (mode === "session-error") {
        send({ type: "response", command: "switch_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      currentSessionFile = cmd.sessionPath ?? currentSessionFile;
      if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ switchSession: cmd.sessionPath ?? null }) + "\n");
      send({ type: "response", command: "switch_session", success: true, data: { sessionId: "s-resumed", sessionFile: currentSessionFile } });
      return;
    case "set_model": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ setModel: { provider: cmd.provider, modelId: cmd.modelId } }) + "\n");
        } catch {}
      }
      send({ type: "response", command: "set_model", success: true, data: { id: cmd.modelId, provider: cmd.provider } });
      return;
    }
    case "set_thinking_level":
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ thinkingLevel: cmd.level }) + "\n");
        } catch {}
      }
      send({ type: "response", command: "set_thinking_level", success: true });
      return;
    case "prompt":
      if (mode === "prompt-reject") {
        // pi rejects a prompt submitted while a compaction runs.
        send({ type: "response", command: "prompt", success: false, error: "fake pi: compaction in progress" });
        return;
      }
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(
            process.env.FAKE_PI_DUMP,
            JSON.stringify({ prompt: { message: cmd.message, ...(Array.isArray(cmd.images) ? { images: cmd.images } : {}) } }) + "\n",
          );
        } catch {}
      }
      send({ type: "response", command: "prompt", success: true });
      turnAborted = false;
      const promptText = typeof cmd.message === "string" ? cmd.message : "";
      if (process.env.FAKE_PI_ROOM_PLAN) {
        streamRoomTurn(promptText);
        return;
      }
      if (process.env.FAKE_PI_HOLD_ON && promptText.includes(process.env.FAKE_PI_HOLD_ON)) {
        holdTurn();
        return;
      }
      if (process.env.FAKE_PI_STALL_ON && promptText.includes(process.env.FAKE_PI_STALL_ON)) {
        holdTurn("half an answer, then silence");
        return;
      }
      if (process.env.FAKE_PI_DELAY_ON && promptText.includes(process.env.FAKE_PI_DELAY_ON)) {
        delayTurn(promptText);
        return;
      }
      if (claudeCompat) {
        compatPrompt();
        return;
      }
      if (mode === "tooluse") streamToolTurn();
      else if (mode === "priced") streamPricedTurn();
      else if (mode === "priced-stop") startPricedToolTurn();
      else if (mode === "permission") streamPermissionTurn();
      else if (mode === "question-select") streamQuestionSelectTurn();
      else if (mode === "question-input") streamQuestionInputTurn();
      else if (mode === "interleave") streamInterleaveTurn();
      else if (mode === "turn-error") streamErrorTurn();
      else if (mode === "compaction") streamCompactionTurn();
      else if (mode === "compaction-recovery") streamCompactionRecoveryTurn();
      else if (mode === "compaction-recovery-upstream") streamCompactionRecoveryUpstreamTurn();
      else if (mode === "omp-chunk") streamChunkedTurn();
      else streamTurn();
      return;
    case "steer": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ steer: { id: cmd.id, message: cmd.message } }) + "\n");
        } catch {}
      }
      const steerAck = (frame: any, success: boolean) =>
        send({
          type: "response",
          command: "steer",
          ...(frame.id !== undefined ? { id: frame.id } : {}),
          ...(success ? { success: true } : { success: false, error: "fake pi: nothing to steer" }),
        });
      if (process.env.FAKE_PI_STEER_OUT_OF_ORDER) {
        if (heldSteerFrames.length === 0) {
          heldSteerFrames.push(cmd);
          return;
        }
        steerAck(heldSteerFrames[0], false);
        steerAck(cmd, true);
        heldSteerFrames.length = 0;
        return;
      }
      steerAck(cmd, !process.env.FAKE_PI_STEER_REFUSE);
      return;
    }
    case "extension_ui_response": {
      const waiter = uiWaiters.get(String(cmd.id));
      if (waiter) {
        uiWaiters.delete(String(cmd.id));
        waiter(cmd.cancelled ? undefined : String(cmd.value ?? ""));
        return;
      }
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ uiResponse: cmd }) + "\n");
        } catch {}
      }
      if (cmd.id === "ask-1") finishPermissionTurn();
      else if (cmd.id === "ask-select" || cmd.id === "ask-input") finishPermissionTurn();
      return;
    }
    case "abort":
      turnAborted = true;
      send({ type: "turn_end", message: { stopReason: "cancelled", usage: { input: 0, output: 0 } }, usage: { input: 0, output: 0 } });
      return;
    default:
      return;
  }
}

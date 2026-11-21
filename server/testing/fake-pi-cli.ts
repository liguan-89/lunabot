#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface for pi.ts tests. Env knobs:
//   FAKE_PI_PERMISSION_ON  prompts containing this substring run the permission ask (Run bash: echo hi?) instead of the plan
//   FAKE_PI_PERMISSION_ON_STEER  an accepted steer carrying this substring raises the same ask once it lands
//   FAKE_PI_QUESTION_ON  prompts containing this substring ask a select question ("Which colour?") instead of the plan
//   FAKE_PI_MODE  happy (default) | tooluse | priced | priced-stop | permission | interleave | question-select | question-input
//     | turn-error | no-models | exit-early | compaction | compaction-recovery
//     | compaction-recovery-upstream | prompt-reject | omp-chunk
//     | session-slow (answers new_session after FAKE_PI_SESSION_DELAY_MS, default 800, and dumps {sessionReplied})
//   FAKE_PI_MODELS  provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_DUMP  path to append {argv, env} JSON to
//   FAKE_PI_STEER_REFUSE  answer a steer with an explicit success:false
//   FAKE_PI_NO_SCOPE_RECEIPT  never write the boot scope receipt, as an extension that could not enforce would
//   FAKE_PI_SWITCH_FAIL  refuse switch_session while new_session still succeeds (strict-resume rebuild)
//   FAKE_PI_THINKING_REFUSE  answer set_thinking_level with success:false (effort notice)
//   FAKE_PI_STEER_OUT_OF_ORDER  hold the first steer until a second arrives, then refuse the first and accept the second
//   FAKE_PI_REPLIES  JSON array of replies (string, or string[] for several items) used in order
//   FAKE_PI_REPLY_FILE  path whose text is the reply while it exists, read again each turn
//   FAKE_PI_REPLY_STATE  counter file keeping FAKE_PI_REPLIES in order across processes
//   FAKE_PI_MARKER_REPLIES  path of {"marker": "reply"}: the first marker a prompt contains picks the reply
//   FAKE_PI_TOOL_CALLS  JSON [{name, input?, ok?, output?, hold?}] the turn calls before replying; `hold` waits for
//     FAKE_PI_RELEASE
//   FAKE_PI_TOOL_CALLS_FILE  path of the same JSON, read again each turn
//   FAKE_PI_RELEASE  path: a held call, or a hang/slow turn, ends once it exists
//   FAKE_PI_MODE=slow  calls its scripted tools, then replies once FAKE_PI_SLOW_FINISH_GATE exists (a body of "fail"
//     ends the turn in error); FAKE_PI_SLOW_TAIL_TOOL=1 adds one more call before the reply
//   FAKE_PI_STEER_RECEIVED  path: written once a steer arrives inside a turn
//   FAKE_PI_PROMPTS  JSON-lines file of {message: {content}} for every prompt the process receives
//   FAKE_PI_MOUNT_TOOLS  1: mount the turn's MCP servers at boot, so a scripted call with `server` reaches their tools
//   FAKE_PI_EXIT_AFTER_TURN  1: exit once the turn is answered, so the next turn relaunches on its session file
// The retired Claude fixture's FAKE_CLAUDE_* names drive the same knobs while FAKE_PI_CLAUDE_COMPAT=1.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import piMcpExtension from "../drivers/pi-mcp-extension.ts";
import { VOLATILE_CONTEXT_CLEARED_NOTE, VOLATILE_CONTEXT_NOTE_PREFIX } from "../drivers/prompt-split.ts";
import { TURN_CLOCK_LEAD } from "../turn-clock.ts";
import { resolveAgentsCall } from "../../shared/agents-tool-names.ts";
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
/** The level the driver booted this child at, for plan evidence that says what a turn ran under. */
const approvalModeAtBoot: string | null = process.env.OMB_APPROVAL_MODE ?? null;

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
  // A scoped turn's receipt is written inside the extension's session_start hook, which real pi fires at boot.
  const activeTools = new Set<string>();
  const sessionStartHooks: (() => unknown)[] = [];
  try {
    await piMcpExtension({
      registerTool: (definition: RegisteredTool) => {
        tools.push({ name: definition.name, label: definition.label, invoke: definition.execute });
        activeTools.add(definition.name);
      },
      on: (event: string, handler: () => unknown) => {
        if (event === "session_start") sessionStartHooks.push(handler);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools.clear();
        for (const name of names) activeTools.add(name);
      },
    });
    // FAKE_PI_NO_SCOPE_RECEIPT simulates an old pi that loads the extension but never fires session_start:
    // the driver's fail-closed path then has to reject the scoped turn, as it would against stale pi.
    if (!process.env.FAKE_PI_NO_SCOPE_RECEIPT) {
      for (const hook of sessionStartHooks) await hook();
    }
    return tools;
  } catch (error) {
    process.stderr.write(`[fake-pi] mounting MCP tools failed: ${String((error as Error)?.message ?? error)}\n`);
    return tools;
  }
}

// A scripted turn that calls through an MCP server needs its tools mounted at boot: the driver removes the config once
// the real extension has mounted it, so a later mount would find nothing. FAKE_PI_MOUNT_TOOLS=1 asks for that.
// A scoped turn never calls a tool at all, so laziness starves it of the session_start receipt the driver waits on:
// mount eagerly whenever the config asks for one, as real pi fires session_start at boot.
function scopeReceiptDemanded(): boolean {
  try {
    const config = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG ?? "", "utf8")) as { scopeReadyPath?: unknown };
    return typeof config.scopeReadyPath === "string";
  } catch {
    return false;
  }
}
let mountedTools: MountedTool[] = (process.env.FAKE_PI_ROOM_PLAN || process.env.FAKE_PI_MOUNT_TOOLS === "1" || scopeReceiptDemanded()) && !argv.includes("--version") && !argv.includes("-v")
  ? await mountMcpTools()
  : [];
let mountPromise: Promise<MountedTool[]> | null = null;
/** Mount the turn's MCP servers on first use through the real extension, as pi does before it runs any tool. */
async function ensuredTools(): Promise<MountedTool[]> {
  if (mountedTools.length) return mountedTools;
  mountPromise ??= mountMcpTools();
  mountedTools = await mountPromise;
  return mountedTools;
}
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
  // Plans may speak a retired alias ("list_triggers", "create_trigger"); the proxy maps it to today's action tool.
  const call = resolveAgentsCall(name, (args ?? {}) as Record<string, unknown>);
  const tools = await ensuredTools();
  const tool = tools.find((candidate) => candidate.label === `agents:${call.name}` || candidate.name === call.name || candidate.name.endsWith(`_${call.name}`));
  if (!tool) throw new Error(`the pi fixture mounted no agents tool named ${call.name} (mounted: ${tools.map((candidate) => candidate.name).join(", ")})`);
  return tool.invoke(`plan-${++planStep}`, call.name === "ask_user" ? askArgs(call.arguments) : call.arguments, undefined, undefined, {
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
        pid: process.pid,
        argv,
        cwd: process.cwd(),
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

// Real pi fires session_start at boot, and the extension's scope enforcement writes its receipt
// there; the fake only mounts tools on use, so a scoped turn would wait on a receipt that only
// a tool call could produce. The config's toolScope is already the driver's normalized scope, so
// the receipt echoes it verbatim, as intersect() does.
if (process.env.OMB_MCP_CONFIG && process.env.FAKE_PI_NO_SCOPE_RECEIPT !== "1") {
  try {
    const bootConfig = JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8")) as { scopeReadyPath?: unknown; toolScope?: unknown };
    if (typeof bootConfig?.scopeReadyPath === "string" && bootConfig.toolScope !== undefined) {
      writeFileSync(bootConfig.scopeReadyPath, JSON.stringify({ ok: true, toolScope: bootConfig.toolScope }), { mode: 0o600 });
    }
  } catch { /* A config the extension could not read leaves no receipt, which fails closed. */ }
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
let forkCounter = 0;
let currentSessionFile: string | null = null;
const heldSteerFrames: any[] = [];

const streamTurn = (promptText: string) => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const marked = markerReply(promptText);
  for (const delta of marked !== undefined ? [marked] : ["Hello", " from", " pi"]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  const context = Number(process.env.FAKE_PI_CONTEXT_TOKENS ?? process.env.FAKE_CLAUDE_CONTEXT_TOKENS);
  const usage = Number.isSafeInteger(context) && context > 0 ? { input: context, output: 3 } : { input: 12, output: 3 };
  send({ type: "turn_end", message: { stopReason: "end_turn", usage }, usage });
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

// A tool that returns an image alongside its text, as an MCP tool that renders a chart does.
const streamImageToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "chart", args: { series: [1, 2, 3] } });
  send({
    type: "tool_execution_end", toolCallId: "call_1", toolName: "chart", isError: false,
    result: { content: [
      { type: "text", text: "chart rendered" },
      { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", mimeType: "image/png" },
    ] },
  });
  send({ type: "turn_end", message: { stopReason: "toolUse", usage: { input: 5, output: 1 } }, usage: { input: 5, output: 1 } });
  send({ type: "turn_start" });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "charted" } });
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

let turnAborted = false;

// The retired Claude fixture's knobs, read under the fake pi's own names too: a scripted turn says what to call,
// what to answer, and how long to stay open, whatever process or respawn delivers it.
const knob = (name: string, legacy: string): string | undefined =>
  process.env[`FAKE_PI_${name}`] ?? (claudeCompat ? process.env[`FAKE_CLAUDE_${legacy}`] : undefined);

const scriptedReplies = (() => {
  try {
    const parsed = JSON.parse(knob("REPLIES", "REPLIES") ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
let scriptedReplyIndex = 0;

/** A prompt's own text: pi's first turn carries the system prompt before the time line. */
function ownPromptText(promptText: string): string {
  const clockAt = promptText.indexOf(TURN_CLOCK_LEAD);
  return clockAt >= 0 ? promptText.slice(clockAt) : ownTurnText({ message: { content: promptText } });
}

function markerReply(promptText: string): string | undefined {
  const path = knob("MARKER_REPLIES", "MARKER_REPLIES");
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const found = Object.entries(parsed ?? {}).find(([marker, reply]) => typeof reply === "string" && promptText.includes(marker));
    return found?.[1] as string | undefined;
  } catch {
    return undefined;
  }
}

/** The next reply: a file's text while it exists, a marker's reply, or the scripted list's next entry — kept in
 * order across processes by a state file when a recipe drives several launches. */
function nextReplies(promptText: string): string[] {
  const replyFile = knob("REPLY_FILE", "REPLY_FILE");
  if (replyFile && existsSync(replyFile)) return [readFileSync(replyFile, "utf8")];
  const marked = markerReply(promptText);
  if (marked !== undefined) return [marked];
  const stateFile = knob("REPLY_STATE", "REPLY_STATE");
  let index = scriptedReplyIndex;
  if (stateFile) {
    try {
      index = Number(readFileSync(stateFile, "utf8")) || 0;
    } catch {}
    try {
      writeFileSync(stateFile, String(index + 1));
    } catch {}
  } else {
    scriptedReplyIndex += 1;
  }
  const reply = scriptedReplies[index];
  if (Array.isArray(reply)) return reply.map(String);
  if (typeof reply === "string") return [reply];
  return [claudeCompat ? "hello from fake claude" : "Hello from pi"];
}

interface ScriptedCall { name: string; input: Record<string, unknown>; ok: boolean; output?: string; parts?: unknown[]; server?: string; hold?: boolean }

/** The calls a turn makes before its reply, read again each turn so a warm process's turns can differ. */
function scriptedToolCalls(): ScriptedCall[] {
  const file = knob("TOOL_CALLS_FILE", "TOOL_CALLS_FILE");
  const raw = file ? (existsSync(file) ? readFileSync(file, "utf8") : "") : knob("TOOL_CALLS", "TOOL_CALLS") ?? "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object")
      .map((call) => ({
        name: String(call.name ?? "Bash"),
        input: (call.input as Record<string, unknown>) ?? {},
        ok: call.ok !== false,
        ...(typeof call.output === "string" ? { output: call.output } : {}),
        ...(Array.isArray(call.output) ? { parts: call.output } : {}),
        ...(typeof call.server === "string" ? { server: call.server } : {}),
        ...(call.hold === true ? { hold: true } : {}),
      }));
  } catch {
    return [];
  }
}

/** Run the scripted calls in order, each held one until FAKE_PI_RELEASE exists and each `server` call through the MCP
 * tool the turn really mounted. */
async function playScriptedCalls(calls: ScriptedCall[], index = 0): Promise<void> {
  const call = calls[index];
  if (!call) return;
  const id = `compat-${index}`;
  send({ type: "tool_execution_start", toolCallId: id, toolName: call.name, args: call.input });
  let ok = call.ok;
  let text = call.output ?? (call.ok ? "ok" : "failed");
  if (call.server) {
    try {
      const result = await callMountedTool(call.name, call.input) as { content?: Array<{ text?: unknown }>; isError?: boolean };
      const spoken = (result?.content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
      if (spoken) text = spoken;
      ok = result?.isError !== true;
    } catch (error) {
      ok = false;
      text = String((error as Error)?.message ?? error);
    }
  } else if (call.hold) {
    const release = knob("RELEASE", "RELEASE");
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (turnAborted || !release || !existsSync(release)) return;
        clearInterval(poll);
        resolve();
      }, 100);
    });
  }
  send({
    type: "tool_execution_end", toolCallId: id, toolName: call.name, isError: !ok,
    // A scripted content list keeps its images (a chart a tool rendered); otherwise the text, as a shell result is.
    result: call.parts ? { content: call.parts } : text,
  });
  // A model takes a moment to write its next call; back-to-back frames would only test the coalescing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return playScriptedCalls(calls, index + 1);
}

function exitAfterTurn(): void {
  if (!knob("EXIT_AFTER_TURN", "EXIT_AFTER_TURN")) return;
  setTimeout(() => process.exit(0), 50);
}

function finishCompatTurn(replies: string[]): void {
  const context = Number(process.env.FAKE_PI_CONTEXT_TOKENS ?? process.env.FAKE_CLAUDE_CONTEXT_TOKENS);
  const usage = Number.isSafeInteger(context) && context > 0 ? { input: context, output: 3 } : { input: 12, output: 3 };
  // As the retired fixture did: each scripted entry is an assistant message of its own, so a working note and the
  // answer that follows are separate rows of the turn.
  for (const reply of replies) {
    send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
  }
  send({ type: "turn_end", message: { stopReason: "end_turn", usage }, usage });
  send({ type: "agent_end", isTerminal: true });
  exitAfterTurn();
}

/** A turn that fails as the engine reports it, rather than with a reply. */
function failTurn(message: string): void {
  send({ type: "turn_end", message: { stopReason: "error", errorMessage: message }, usage: { input: 0, output: 0 } });
  send({ type: "agent_end", isTerminal: true });
  exitAfterTurn();
}

/** The retired fixture's `slow` turn: its scripted calls, then a reply once the finish gate exists. */
let steered: string[] = [];
function slowTurn(promptText: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  steered = [];
  const own = ownPromptText(promptText);
  const finish = () => {
    if (turnAborted) return;
    if (knob("SLOW_TAIL_TOOL", "SLOW_TAIL_TOOL")) {
      send({ type: "tool_execution_start", toolCallId: "tail", toolName: "Bash", args: { command: "echo tail" } });
      send({ type: "tool_execution_end", toolCallId: "tail", toolName: "Bash", isError: false, result: { content: [{ type: "text", text: "tail" }] } });
    }
    const gate = knob("SLOW_FINISH_GATE", "SLOW_FINISH_GATE");
    if (gate && existsSync(gate)) {
      try {
        if (readFileSync(gate, "utf8").trim() === "fail") return failTurn("fixture turn failed");
      } catch {}
    }
    const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
    finishCompatTurn([`reply to: ${own}${tail}`]);
  };
  void playScriptedCalls(scriptedToolCalls()).then(() => {
    const gate = knob("SLOW_FINISH_GATE", "SLOW_FINISH_GATE");
    if (!gate) return void setTimeout(finish, 800);
    const poll = setInterval(() => {
      if (turnAborted) return void clearInterval(poll);
      if (!existsSync(gate)) return;
      clearInterval(poll);
      // Timers run before the poll phase that reads the pipe, so finishing here could leave a steer unread.
      setImmediate(finish);
    }, 10);
  });
}

/** The bridge for the retired fixture's `happy`/`hang` turns. */
function compatPrompt(promptText: string): void {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  steered = [];
  const hang = knob("MODE", "MODE") === "hang";
  const reply = () => {
    if (!hang) return finishCompatTurn(nextReplies(promptText));
    const release = knob("RELEASE", "RELEASE");
    if (!release) return void setInterval(() => {}, 1_000);
    const poll = setInterval(() => {
      if (turnAborted) return void clearInterval(poll);
      if (!existsSync(release)) return;
      clearInterval(poll);
      finishCompatTurn(nextReplies(promptText));
    }, 100);
  };
  void playScriptedCalls(scriptedToolCalls()).then(reply);
}
/** pi sends the system prompt only on a session's first turn (and on a re-anchor); later turns carry the note that
 * replaced its volatile half. Keep both so evidence and `expectSystemIncludes` see what the model actually has. */
let roomFullSystem: string | null = null;
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
  steered = [];
  const integration = roomIntegration();
  // The time line leads each turn's own text; the words before it are the system prompt on a session's first
  // turn, or the volatile-context note that replaced part of it on a later one. Either is what the model reads now.
  const clockAt = message.indexOf(TURN_CLOCK_LEAD);
  const prefix = clockAt >= 0 ? message.slice(0, clockAt).trimEnd() : "";
  let systemChecks = roomFullSystem ?? message;
  if (prefix.startsWith(VOLATILE_CONTEXT_NOTE_PREFIX) || prefix.startsWith(VOLATILE_CONTEXT_CLEARED_NOTE)) {
    roomSystemPrompt = prefix;
    systemChecks = `${roomFullSystem ?? ""}\n${prefix}`;
  } else if (prefix) {
    roomFullSystem = prefix;
    roomSystemPrompt = prefix;
    systemChecks = prefix;
  }
  const text = clockAt >= 0 ? message.slice(clockAt) : message;
  const system = roomSystemPrompt ?? message;
  void runRoomHandoffAgent([], process.env.FAKE_PI_ROOM_PLAN!, { message: { content: text } },
    { integration, system },
    (progress) => {
      if (turnAborted) return;
      send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: progress } });
    },
    () => steered,
    {
      integration,
      system,
      systemChecks,
      approvalMode: approvalModeAtBoot,
      ownText: ownTurnText({ message: { content: text } }),
      context: message,
      tools: mountedTools.map((tool) => tool.label?.split(":").at(-1) ?? tool.name),
      callTool: (name, args) => callMountedTool(name, args),
      onToolStart: (trace) => send({ type: "tool_execution_start", toolCallId: trace.id, toolName: trace.name, args: trace.args }),
      onToolEnd: (trace) => send({ type: "tool_execution_end", toolCallId: trace.id, toolName: trace.name, isError: !trace.ok, result: trace.result }),
      onCompact: () => {
        send({ type: "compaction_start", reason: "threshold" });
        send({ type: "compaction_end", reason: "threshold", result: { summary: "fake summary", firstKeptEntryId: "e1", tokensBefore: 100 }, aborted: false, willRetry: false });
      },
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
      // Real pi's open answer is `{cancelled}` alone; the file only surfaces
      // through get_state — same as this fake reports it.
      const sessionReply = { type: "response", command: "new_session", success: true, data: { cancelled: false } };
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
      if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ switchSession: cmd.sessionPath ?? null }) + "\n");
      // FAKE_PI_SWITCH_FAIL=1 refuses only the resume; a fresh new_session still
      // works, so a strict-resume driver can rebuild on it.
      if (mode === "session-error" || process.env.FAKE_PI_SWITCH_FAIL === "1") {
        send({ type: "response", command: "switch_session", success: false, error: "fake pi: session unavailable" });
        return;
      }
      currentSessionFile = cmd.sessionPath ?? currentSessionFile;
      send({ type: "response", command: "switch_session", success: true, data: { cancelled: false } });
      return;
    case "clone":
      // Real pi forks the session file at the leaf entry and moves this child
      // onto the branch; the original file stays on disk untouched.
      if (mode === "session-error") {
        send({ type: "response", command: "clone", success: false, error: "fake pi: session unavailable" });
        return;
      }
      forkCounter += 1;
      currentSessionFile = `${currentSessionFile ?? `/fake/pi-session-${sessionCounter}.json`}.fork${forkCounter}.json`;
      if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ clone: currentSessionFile }) + "\n");
      send({ type: "response", command: "clone", success: true, data: { cancelled: false } });
      return;
    case "compact": {
      if (process.env.FAKE_PI_DUMP) appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ compact: { instructions: cmd.customInstructions ?? null } }) + "\n");
      if (process.env.FAKE_PI_COMPACT_FAIL === "1") {
        send({ type: "response", command: "compact", success: false, error: "fake pi: compaction failed" });
        return;
      }
      send({ type: "compaction_start", reason: "manual" });
      const result = {
        summary: "fake pi summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 2000,
        usage: { input: 1500, output: 80, cacheRead: 200, cacheWrite: 0, totalTokens: 1780, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 } },
      };
      send({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      send({ type: "response", command: "compact", success: true, data: result });
      return;
    }
    case "set_model": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ setModel: { provider: cmd.provider, modelId: cmd.modelId } }) + "\n");
        } catch {}
      }
      // FAKE_PI_EXIT_ON_FIRST_MODEL=1: the primary model's engine dies before
      // the prompt, so a backup model on the same instance can take the turn —
      // automatic recovery's fixture.
      if (process.env.FAKE_PI_EXIT_ON_FIRST_MODEL === "1" && `${cmd.provider}/${cmd.modelId}` === `${modelPairs[0]?.provider}/${modelPairs[0]?.id}`) {
        process.exit(1);
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
      // FAKE_PI_THINKING_REFUSE=1 answers as a model that takes no level.
      if (process.env.FAKE_PI_THINKING_REFUSE === "1") {
        send({ type: "response", command: "set_thinking_level", success: false, error: "fake pi: model takes no thinking level" });
        return;
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
            JSON.stringify({ pid: process.pid, prompt: { message: cmd.message, ...(Array.isArray(cmd.images) ? { images: cmd.images } : {}) } }) + "\n",
          );
        } catch {}
      }
      send({ type: "response", command: "prompt", success: true });
      turnAborted = false;
      const promptText = typeof cmd.message === "string" ? cmd.message : "";
      const promptLog = knob("PROMPTS", "PROMPTS");
      if (promptLog) {
        try {
          appendFileSync(promptLog, JSON.stringify({ message: { content: promptText } }) + "\n");
        } catch {}
      }
      // A prompt carrying this substring asks the person's permission instead (the retired ACP fixture's
      // permission mode, per prompt so a shared instance can hold one asking bot among quiet ones).
      // `confirm`, not `select`: a confirmation is a permission card, where a select reads as a question.
      if (process.env.FAKE_PI_PERMISSION_ON && promptText.includes(process.env.FAKE_PI_PERMISSION_ON)) {
        send({ type: "agent_start" });
        send({ type: "turn_start" });
        send({ type: "extension_ui_request", id: "ask-1", method: "confirm",
          title: process.env.FAKE_PI_CONFIRM_TITLE ?? "Run bash: echo hi?",
          ...(typeof process.env.FAKE_PI_CONFIRM_MESSAGE === "string" ? { message: process.env.FAKE_PI_CONFIRM_MESSAGE } : {}) });
        return;
      }
      // A prompt carrying this substring asks the person a question instead, so a shared instance can hold one
      // asking bot among quiet ones (the retired ACP fixture's question mode, per prompt).
      if (process.env.FAKE_PI_QUESTION_ON && promptText.includes(process.env.FAKE_PI_QUESTION_ON)) {
        send({ type: "agent_start" });
        send({ type: "turn_start" });
        send({ type: "extension_ui_request", id: "ask-question", method: "select", title: "Which colour?", options: ["Blue", "Green"] });
        return;
      }
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
      if (mode === "slow" || knob("MODE", "MODE") === "slow") {
        slowTurn(promptText);
        return;
      }
      if (claudeCompat) {
        compatPrompt(promptText);
        return;
      }
      if (mode === "tooluse") streamToolTurn();
      else if (mode === "image-tool") streamImageToolTurn();
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
      else streamTurn(promptText);
      return;
    case "steer": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({
            steer: { id: cmd.id, message: cmd.message, ...(Array.isArray(cmd.images) ? { images: cmd.images } : {}) },
          }) + "\n");
        } catch {}
      }
      if (typeof cmd.message === "string") {
        steered.push(ownPromptText(cmd.message));
        const received = knob("STEER_RECEIVED", "STEER_RECEIVED");
        if (received) {
          try {
            writeFileSync(received, "received");
          } catch {}
        }
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
      // An accepted steer carrying this marker raises the turn's own permission ask once it lands, the way
      // those words would run real work into something gated mid-turn.
      const steerPermissionOn = process.env.FAKE_PI_PERMISSION_ON_STEER;
      if (
        !process.env.FAKE_PI_STEER_REFUSE && steerPermissionOn &&
        typeof cmd.message === "string" && cmd.message.includes(steerPermissionOn)
      ) {
        send({
          type: "extension_ui_request", id: "ask-steer", method: "confirm",
          title: process.env.FAKE_PI_CONFIRM_TITLE ?? "Run bash: echo hi?",
          ...(typeof process.env.FAKE_PI_CONFIRM_MESSAGE === "string" ? { message: process.env.FAKE_PI_CONFIRM_MESSAGE } : {}),
        });
      }
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
      // A stopped turn's open dialog is gone: settle it as cancelled so a scripted ask unwinds.
      for (const waiter of uiWaiters.values()) waiter(undefined);
      uiWaiters.clear();
      send({ type: "turn_end", message: { stopReason: "cancelled", usage: { input: 0, output: 0 } }, usage: { input: 0, output: 0 } });
      return;
    default:
      return;
  }
}

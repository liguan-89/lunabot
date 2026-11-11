#!/usr/bin/env node
// Fake of the ZCode CLI's `app-server` stdio surface, for driver contract
// tests of server/drivers/zcode.ts. Speaks the observed wire format: JSON
// lines, no `jsonrpc`, server→client requests with string ids, and
// `session/event` notifications carrying `{type, payload}`.
//
//   FAKE_ZCODE_MODE        happy (default) | fail
//   FAKE_ZCODE_SESSION_ID  the session id the fake reports
//   FAKE_ZCODE_DUMP        path to append every frame (in) and reply (result)
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const dump = (row: unknown) => {
  if (!process.env.FAKE_ZCODE_DUMP) return;
  try {
    appendFileSync(process.env.FAKE_ZCODE_DUMP, JSON.stringify(row) + "\n");
  } catch {
    /* never let dumping break a run */
  }
};

// The driver probes `<cli> version` for snapshot(); answer and exit clean.
if (argv[0] === "version") {
  process.stdout.write("zcode 9.9.9 (fake)\n");
  process.exit(0);
}
if (argv[0] !== "app-server") process.exit(1);

const mode = process.env.FAKE_ZCODE_MODE ?? "happy";
const sessionId = process.env.FAKE_ZCODE_SESSION_ID ?? "sess_fake-1";
let serverSeq = 0;

send({ method: "startup/storageState", params: { phase: "ready" } });

const event = (type: string, payload: Record<string, unknown>) =>
  send({ method: "session/event", params: { type, payload, sessionId, deliveryKind: "desktop-continuous" } });

function handle(msg: any) {
  if (msg.method === undefined) {
    // a client reply to one of our server→client requests
    dump({ reply: msg.result, id: msg.id });
    if (msg.id === "server-perm-1") {
      event("permission.resolved", { requestId: "perm_fake", decision: "allow", reason: "answered" });
      event("turn.completed", { response: "approved and done", usage: { inputTokens: 5, outputTokens: 2 }, resultType: "success" });
    }
    if (msg.id === "server-q-1") {
      event("userInput.resolved", { requestId: "user-input-1" });
      event("turn.completed", { response: "Green it is", usage: { inputTokens: 4, outputTokens: 2 }, resultType: "success" });
    }
    return;
  }
  dump({ method: msg.method, params: msg.params });
  switch (msg.method) {
    case "session/create":
    case "session/resume": {
      const id = `server-${++serverSeq}`;
      send({ method: "session/lifecycle/changed", params: { sessionId, state: "starting" } });
      // The catalog rides the session's first state patch, exactly before the
      // session becomes addressable.
      send({
        method: "state.updated",
        params: {
          patch: {
            model: {
              available: [
                {
                  ref: { providerId: "fake", modelId: "fake-model" },
                  label: "fake-model",
                  reasoning: { defaultLevel: "high", levels: [{ value: "high" }] },
                },
              ],
              current: { providerId: "fake", modelId: "fake-model" },
            },
          },
        },
      });
      // The session is unaddressable until this answer comes back.
      send({ id, method: "session/requestRuntimePreferences", params: { sessionId, scope: "runtime-materialization" } });
      setTimeout(() => send({ method: "session/lifecycle/changed", params: { sessionId, state: "ready" } }), 5);
      setTimeout(() => send({ id: msg.id, result: { sessionId, projection: { sessionId } } }), 10);
      return;
    }
    case "session/subscribe":
      send({ id: msg.id, result: { sessionId, eventSeq: 0, events: [] } });
      return;
    case "session/send": {
      send({ id: msg.id, result: { accepted: true, sessionId } });
      setImmediate(() => {
        send({
          method: "state.updated",
          params: {
            patch: {
              model: {
                available: [
                  {
                    ref: { providerId: "fake", modelId: "fake-model" },
                    label: "fake-model",
                    reasoning: { defaultLevel: "high", levels: [{ value: "high" }] },
                  },
                ],
                current: { providerId: "fake", modelId: "fake-model" },
              },
            },
          },
        });
        event("turn.started", { input: msg.params?.content ?? "" });
        if (mode === "fail") {
          event("turn.failed", { error: "fake zcode failed" });
          return;
        }
        if (mode === "permission") {
          // The ask is a server→client request; the turn waits for its answer.
          send({
            id: "server-perm-1",
            method: "interaction/requestPermission",
            params: {
              sessionId,
              turnId: "turn_fake",
              requestId: "perm_fake",
              toolCallId: "call_fake",
              toolName: "Bash",
              riskLevel: "high",
              reason: "High risk tools require explicit approval",
              input: { command: "echo hi" },
              options: [
                { kind: "allow_once", name: "Allow once", optionId: "allow_once", response: { decision: "allow", reason: "Approved once" } },
                { kind: "allow_always", name: "Always allow in this project", optionId: "allow_project", response: { decision: "allow", reason: "Approved for this project" } },
                { kind: "deny", name: "Deny", optionId: "deny", response: { decision: "deny", reason: "The user denied this action." } },
              ],
            },
          });
          return;
        }
        if (mode === "question") {
          send({
            id: "server-q-1",
            method: "interaction/requestUserInput",
            params: {
              sessionId,
              turnId: "turn_fake",
              requestId: "user-input-1",
              prompt: "Which color?",
              toolName: "AskUserQuestion",
              questions: [
                { question: "Which color?", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] },
              ],
            },
          });
          return;
        }
        for (const delta of ["Hello", " from", " zcode"]) {
          event("model.streaming", { delta, kind: "text_delta", done: false });
        }
        event("turn.completed", {
          response: "Hello from zcode",
          usage: { inputTokens: 7, outputTokens: 3 },
          resultType: "success",
        });
      });
      return;
    }
    default:
      send({ id: msg.id, result: {} });
      return;
  }
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* skip non-JSON line */
    }
  }
});
process.stdin.on("end", () => process.exit(0));

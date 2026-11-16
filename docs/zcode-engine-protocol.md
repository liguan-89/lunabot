# ZCode app-server protocol (notes for a future `zcodeAgent` engine)

Reverse-engineered from the CLI shipped inside the ZCode desktop app
(`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, `zcode 0.17.1`)
and from live probe sessions. Everything below was observed, not guessed,
except where a line says otherwise. This file exists so the driver work does
not have to repeat the probing.

## Getting the CLI

There is no npm package and no standalone `zcode` installer. The CLI ships
inside the ZCode desktop app as
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, and runs under the
app's own Electron runtime in node mode:

```
ELECTRON_RUN_AS_NODE=1 /Applications/ZCode.app/Contents/MacOS/ZCode \
  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs version
```

System Node also runs it (`node zcode.cjs version`). The driver resolves a
bare `zcode` from the augmented PATH first and falls back to that bundle on
macOS; the Settings install card writes a `~/.local/bin/zcode` shim with the
same invocation, so no separate download is expected.

## Per-session MCP servers and images

`session/create` (and `session/resume`) take `mcpServers`: stdio entries are
`{name, command, args, env:[{name,value}], isolation?, alwaysLoad?}`, remote
ones `{type:"http"|"sse", name, url, headers:[{name,value}]}`. They are scoped
to that session, so the driver mounts Luna Bot's proxies when it creates it and
recreates the session when the mount set changes.

`session/send` takes prompt attachments in the composer's shape, not the
resolved one: `{kind:"image", localPath, filename, mimeType, sizeBytes}` (or
`dataBase64` instead of `localPath`). A `{type:"image", path}` object is
silently dropped. ZCode reads the file, resizes it (20 MB cap) and inlines it
as a model image block.

## Process

```
zcode app-server        # JSON lines on stdin/stdout, one frame per line
```

It is **not** JSON-RPC: frames carry no `jsonrpc` field, and a frame that
includes one is rejected with `-32600 Invalid ZCode Protocol message`.

```
→ {"id": 1, "method": "session/list", "params": {}}
← {"id": 1, "result": { ... }}              # success
← {"id": 1, "error": {"code": -32602, "message": "...", "data": {...}}}
← {"method": "session/lifecycle/changed", "params": { ... }}   # notification
← {"id": "server-1", "method": "session/requestRuntimePreferences", "params": {...}}
```

Server → client requests use string ids (`server-N`) and **must** be answered;
a session never becomes `ready` until they are. Zod validates both directions,
and a rejected `result` kills the session (`state: "unloaded"` plus
`lastError.operation: "ensureReady"`).

Framing and connection are long-lived: one `app-server` child can own many
sessions, so the driver wants one child per instance, not per turn.

## Startup noise

The child announces storage before it answers anything:

```
{"method":"startup/storageState","params":{"phase":"checking|committing|ready", ...}}
```

Sessions are **not** addressable until this app-server process has created or
resumed them: `session/events`, `session/messages`, `session/subscribe` and
`session/send` all answer `-32004 Session is not active: <id>` for a session
another process owns.

## Verified methods

| Method | Params (verified shape) | Result |
|---|---|---|
| `session/list` | `{}` | `{sessions:[{sessionId, title, mode, status, workspace:{workspaceKey, workspacePath}, createdAt, updatedAt}]}` |
| `session/create` | `{workspace:{workspacePath, workspaceKey}}` (both strings; documented keys: same values) | session descriptor |
| `session/resume` | `{sessionId}` | session descriptor |
| `session/send` | `{sessionId, content}` (both strings required) | dispatch result; the turn streams as notifications |
| `session/setModel` | `{sessionId, model:{providerId, modelId}}` | — |
| `session/subscribe` | `{sessionId, deliveryKind:"desktop-continuous"\|"web-remote-replayable"}` | `{sessionId, eventSeq, events:[...]}` then live notifications |
| `session/events` | `{sessionId}` | `{events:[{eventId, seq, sessionId, turnId, traceId, timestamp, type, payload}]}` |
| `session/messages` | `{sessionId}` | `{messages:[{info:{role, modelId, providerId, mode, finish, tokens, ...}, parts:[...]}]}` |
| `session/stop` | `{sessionId}` | — |
| `session/close` | `{sessionId}` | — |

Method names are also listed in the bundle as a `sessionCreate:"session/create"`
style map; the full set includes lifecycle, fork, compact, goal, subagents,
`workspace/*`, `provider/*`, `mcp/*`, `plugins/*`, `skills/*`.

## The resume handshake (must be implemented by the client)

```
→ session/resume {sessionId}
← session/lifecycle/changed {state:"starting"}
← {id:"server-1", method:"session/requestRuntimePreferences",
   params:{sessionId, scope:"runtime-materialization"}}
→ {id:"server-1", result:{nativeSearchEnhancementsEnabled:false}}
← session/lifecycle/changed {state:"ready"}
```

A strict-subset answer is rejected one missing field at a time; for
`scope:"runtime-materialization"` the only required field observed is
`nativeSearchEnhancementsEnabled: boolean`.

While starting, the server also fires `interaction/requestOfficialMcpAuthHeaders`
(`{mcpKey, pluginId, requestId, targetOrigin, workspace}`) for official MCP
plugins, and `process/mcpTelemetry` telemetry. A headless driver can leave the
auth request unanswered (the MCP server then has no credentials) but should
not block startup on it.

## Message and part model

`session/messages` returns OpenCode-shaped data, which is also what the event
`payload` mirrors:

```
info:  { id, role: "user"|"assistant", sessionID, modelId, providerId, mode,
         finish: "completed"|..., tokens:{input,output,reasoning,cache:{read,write}},
         time:{created, completed} }
parts: [{ id, messageID, sessionID, type: "text"|"timeline"|"tool"|...,
          text?, time?, ... }]
```

Model identity is a pair, e.g. `{providerId:"opencode-go-messages",
modelId:"deepseek-v4.1-flash"}` or
`{providerId:"account:bigmodel-individual-coding-plan", modelId:"GLM-5.3-Flash"}`.

## Event types (observed on a live turn)

Persisted logs of a finished session carry bookkeeping events
(`session.resumed`, `session.updated`, `session.titleUpdated`,
`checkpoint.created` with workspace snapshot refs). A running turn streams as
`session/event` notifications whose `params` is the event itself:

```
{"method":"session/event","params":{"type":"model.streaming","sessionId":"sess_…",
  "turnId":"turn_…","seq":12,
  "payload":{"assistantMessageId":"msg_…","delta":"收到","done":false,"kind":"text_delta"}}}

{"method":"session/event","params":{"type":"turn.completed","payload":{
  "response":"收到","tokenCount":22139,"toolCallCount":0,"resultType":"success",
  "usage":{"inputTokens":22136,"outputTokens":3,"reasoningTokens":0,...},
  "duration":39935}}}
```

`turn.failed` closes a failed run (`payload.error`). `turn.started` carries
`{messageId, input, queryId, turnNumber}`, and the same information is
mirrored as telemetry under `v4/telemetry/event` with a `kind` field — a driver
should ignore the telemetry channel and read `session/event` only.

Tool calls and permission cards did **not** fire on the observed turns (the
session ran in `yolo`, text-only), so their payload shapes are still
unverified; the driver maps `tool.call.started|completed|failed` and
`permission.requested` defensively.

## Gotchas found while wiring the driver

1. **The session id arrives in the preferences request, not in the create
   result.** `session/create` answers with a projection whose
   `projection.sessionId` can literally read `"unknown"`; the real id is
   `params.sessionId` on `session/requestRuntimePreferences`, which is sent
   *before* create resolves. Answer it (or the session never becomes ready)
   and take the id from there.
2. **`session/setModel` needs a reasoning level for models that have one.**
   `{providerId, modelId}` alone is rejected with
   `Reasoning level is required for <provider>/<model>`; add
   `options:{reasoningLevel}`. The level set comes from the model entry in the
   `state.updated` patch (`reasoning.defaultLevel` / `reasoning.levels`), but
   that catalog only lists the models the child has materialized, so a model
   chosen before it appears needs a fallback level.
3. **`yolo` is the only mode a headless client can drive.** `build` (the
   default) routes every action through an approval card whose answer format
   is not verified; `session/setMode {mode:"yolo"}` makes a session run
   unattended.

## Permissions (verified end to end)

In `build` mode the tool ask arrives as a **server→client request**:

```
← {"id":"server-3","method":"interaction/requestPermission","params":{
     "sessionId":"sess_…","turnId":"turn_…","requestId":"perm_…",
     "toolCallId":"call_…","toolName":"Bash","riskLevel":"high",
     "reason":"High risk tools require explicit approval",
     "input":{"command":"touch …","description":"…"},
     "options":[
       {"kind":"allow_once","name":"Allow once","optionId":"allow_once",
        "response":{"decision":"allow","reason":"Approved once"}},
       {"kind":"allow_always", …,
        "response":{"decision":"allow","permissionUpdates":[…],"reason":"Approved for this project"}},
       {"kind":"deny", …, "response":{"decision":"deny","reason":"…"}}]}}
```

**Answer with the chosen option's own `response` object** — that is the
`q4` schema the child validates (`{decision, reason?, modifiedInput?,
permissionUpdates?}`). Replying `{optionId}` or `{behavior}` instead resolves
the request as `deny` with reason `"Permission request failed"`.

`session/event` mirrors the ask as `permission.requested` (same requestId) and
the outcome as `permission.resolved {decision}`; that mirror is bookkeeping —
answer the `interaction/requestPermission` request. `interaction/` also
carries `requestUserInput` (same shape for questions) and
`requestOfficialMcpAuthHeaders`.

Verified through the driver: ask surfaced as `request.opened`, answered
`allow`, the tool ran (`approved.txt` created), the model answered, and the
turn completed `ok:true`.

## The model's own question (`interaction/requestUserInput`)

Same server→client request pattern, different answer shape:

```
← {"id":"server-4","method":"interaction/requestUserInput","params":{
     "sessionId":"sess_…","turnId":"turn_…","requestId":"…","prompt":"Which color?",
     "toolName":"AskUserQuestion",
     "questions":[{"question":"Which color?","header":"Color","multiSelect":false,
                   "options":[{"label":"Blue"},{"label":"Green"}]}]}}
```

Answer with an **action**, not a permission decision:

```
→ {"id":"server-4","result":{"action":"accept","content":{"answers":{"Which color?":"Green"}}}}
→ {"id":"server-4","result":{"action":"decline"}}      // dismissed / timed out
```

`content.answers` is keyed by the question text; a single free-text ask accepts
`{"answer":"…"}` instead. `session/event` mirrors the flow as
`userInput.requested` / `userInput.resolved`.

## What is still open

1. Only single-question cards have been exercised live. A multi-question
   card relies on Luna Bot's `Q: … / A: …` block format to map answers back
   to question text; that mapping is covered by the fake CLI but not by a real
   multi-question ask.

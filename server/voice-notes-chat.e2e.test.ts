// Voice notes inside a folded or long-running conversation, on the fixture's fake pi: the room plan scripts the
// turn and a loopback speech stub stands in for the voice provider, so no external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { request } from "../scripts/mcp-server.ts";

const MP3 = Buffer.from("ID3 fake mp3 for the chat voice note fixture");

async function withChatVoice(test: (f: {
  seen: Array<{ input: string; voice: string }>;
  dataDir: string;
  api(path: string, body?: unknown, method?: string): Promise<any>;
  control(args: string[]): Promise<any>;
  savePlan(plan: Record<string, unknown>): void;
  evidence(): any[];
  messages(threadId: string): Promise<any[]>;
  audioFiles(): string[];
  newBot(name: string): Promise<any>;
  settle(bot: any, text: string): Promise<void>;
  serveTts(options?: { fail?: boolean }): Promise<string>;
}) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const control = (args: string[]) => runControlLunabot([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const seen: Array<{ input: string; voice: string }> = [];
  const dataDir = session.info.dataDir;
  const planPath = join(dataDir, "room-plan.json");
  let ttsServer: Server | undefined;
  try {
    await test({
      seen,
      dataDir,
      api,
      control,
      savePlan: (plan) => writeFileSync(planPath, JSON.stringify(plan)),
      evidence: () => existsSync(planPath + ".evidence.jsonl")
        ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
      messages: async (threadId) => inOrder((await api(`/api/threads/${threadId}/messages?limit=200`, undefined, "GET")).messages),
      audioFiles: () => {
        const dir = join(dataDir, "attachments");
        return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".mp3")) : [];
      },
      newBot: async (name) => (await control(["new-bot", "--name", name])).bot,
      settle: async (bot, text) => {
        await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text]);
        expect((await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "40"])).status).toBe("settled");
      },
      serveTts: async (options) => {
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (chunk: Buffer) => { raw += chunk; });
          req.on("end", () => {
            if (!(req.url ?? "").includes("/audio/speech")) { res.writeHead(404); res.end(); return; }
            const body = JSON.parse(raw);
            seen.push({ input: String(body.input ?? ""), voice: String(body.voice ?? "") });
            if (options?.fail) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "speech stub is down" }));
              return;
            }
            res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(MP3.byteLength) });
            res.end(MP3);
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        ttsServer = server;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no stub port");
        return `http://127.0.0.1:${address.port}`;
      },
    });
  } finally {
    ttsServer?.close();
    await session.close();
  }
}

const audioOf = (messages: any[]) => messages.flatMap((message) => (message.attachments ?? []).filter((file: any) => file.kind === "audio").map((file: any) => ({ message, file })));
/** The thread as the chat reads it: from its newest line back along each line's parent. */
const inOrder = (messages: any[]) => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const parents = new Set(messages.map((message) => message.parentId));
  const path: any[] = [];
  for (let at = messages.findLast((message) => !parents.has(message.id)); at; at = byId.get(at.parentId)) path.unshift(at);
  return path;
};
/** The note as the bot wrote it in the turn that folded mid-conversation. */
const NOTE = "Hi there, it is your assistant. Here is your voice note, sent fresh with this message, so you can hear it right away.";
const voiceStep = (evidence: any[], tool = "send_voice_note") => evidence.find((entry: any) => entry.step?.tool === tool);

it("keeps voice notes attached to their own replies across a folded conversation", async () => withChatVoice(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = await f.newBot("Chat voice bot");
  f.savePlan({
    [bot.id]: {
      turns: [
        { steps: [{ tool: "send_voice_note", arguments: { text: "The export finished." } }], reply: "Here is the summary." },
        { steps: [], reply: "Noted." },
        { steps: [], reply: "Noted." },
        { steps: [], reply: "Noted." },
        { steps: [{ tool: "send_voice_note", arguments: { text: "Second note after the summary." } }], reply: "Second reply." },
      ],
    },
  });

  await f.settle(bot, "Send me a voice note.");
  const first = voiceStep(f.evidence().find((entry: any) => entry.botId === bot.id)?.evidence ?? []);
  expect(first.response.result.content[0].text).toContain("Voice note recorded");
  expect(audioOf(await f.messages(bot.activeTaskId)).map((note) => [note.message.text, note.file.text])).toEqual([["Here is the summary.", "The export finished."]]);
  expect(f.audioFiles()).toHaveLength(1);

  // Every turn from here folds the conversation before it runs, as a long chat does.
  await f.api("/api/config", { context: { compactAt: 1 } }, "PATCH");
  for (const line of ["First older request.", "Second older request.", "Third older request."]) await f.settle(bot, line);
  await f.settle(bot, "Another voice note, please.");

  const messages = await f.messages(bot.activeTaskId);
  expect(messages.filter((message) => message.kind === "compaction").length).toBeGreaterThan(0);
  expect(audioOf(messages).map((note) => [note.message.text, note.file.text])).toEqual([
    ["Here is the summary.", "The export finished."],
    ["Second reply.", "Second note after the summary."],
  ]);
  expect(f.audioFiles()).toHaveLength(2);
}), 120_000);

it("says the note was not sent, and keeps no file, when the voice provider fails", async () => withChatVoice(async (f) => {
  const baseUrl = await f.serveTts({ fail: true });
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = await f.newBot("Failing voice bot");
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "This note cannot be spoken." }, expectError: true }],
      reply: "Reply without a note.",
    },
  });
  await f.settle(bot, "Send me a voice note.");

  const step = voiceStep(f.evidence().find((entry: any) => entry.botId === bot.id)?.evidence ?? []);
  expect(step.response.result.isError).toBe(true);
  expect(step.response.result.content[0].text).toContain("Voice note not sent");
  expect(f.seen).toEqual([{ input: "This note cannot be spoken.", voice: "voice-a" }]);
  expect(audioOf(await f.messages(bot.activeTaskId))).toEqual([]);
  expect(f.audioFiles()).toEqual([]);
}), 90_000);

it("records a note with its audio on disk in a folded long turn beside failed calls, on the reply", async () => withChatVoice(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  await f.api("/api/config", { context: { compactAt: 1 } }, "PATCH");
  const bot = await f.newBot("Long turn voice bot");
  f.savePlan({
    [bot.id]: {
      turns: [
        { steps: [], reply: "Noted." },
        { steps: [], reply: "Noted." },
        { steps: [], reply: "Noted." },
        {
          steps: [
            { tool: "send_voice_note", arguments: { text: NOTE } },
            { tool: "send_voice_note", arguments: { text: "" }, expectError: true },
            { tool: "list_bots", arguments: {} },
          ],
          reply: "Voice note is attached to this reply.",
        },
      ],
    },
  });
  for (const line of ["First older request.", "Second older request.", "Third older request."]) await f.settle(bot, line);
  await f.settle(bot, "hi send vouse message");

  const turnEvidence = f.evidence().find((entry: any) => entry.botId === bot.id && (entry.evidence ?? []).some((e: any) => e.step?.tool === "send_voice_note"));
  const recorded = voiceStep(turnEvidence.evidence);
  expect(recorded.response.result.content[0].text).toMatch(/^Voice note recorded\. /);
  const refused = turnEvidence.evidence.find((entry: any) => entry.step?.tool === "send_voice_note" && entry.step.arguments?.text === "");
  expect(refused.response.result.isError).toBe(true);

  const messages = await f.messages(bot.activeTaskId);
  expect(messages.filter((message) => message.kind === "compaction").length).toBeGreaterThan(0);
  const turn = messages.find((message) => message.text === "Voice note is attached to this reply.")?.turnId;
  expect(turn).toBeTruthy();
  const failed = messages.filter((message) => message.kind === "activity" && message.turnId === turn && message.tool?.ok === false);
  expect(failed.length).toBeGreaterThanOrEqual(1);
  const notes = audioOf(messages).filter((note) => note.message.turnId === turn);
  expect(notes.map((note) => [note.message.text, note.file.text])).toEqual([["Voice note is attached to this reply.", NOTE]]);
  expect(f.audioFiles()).toContain(notes[0]!.file.path.split(/[\\/]/).pop());
}), 120_000);

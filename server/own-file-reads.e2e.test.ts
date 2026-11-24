// Real isolated server + the fake pi's own permission dialog, as card-answerers.e2e.test.ts drives it: a bot on Ask that
// reads its own files (its SOUL.md, a skill revision, its memory) is answered by the server with no card at all, while a
// read of anything else, or a command that does more than read, still asks the person. No real model calls, user
// profiles or shell commands are used.
//
// pi asks through one confirm dialog per turn (`extension_ui_request`), and the harness reads the command from the
// dialog's message — the same place it reads a gated bash call's input from. A pi process is warm per conversation, so
// each case below runs in a thread of its own: a fresh child, launched with the command that thread asks about.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-lunabot.ts";

const MARKER = "read this for me";

// The reads asked about are a POSIX shell's commands on POSIX paths.
it.skipIf(process.platform === "win32")("answers a bot's plain reads of its own files at Ask with no card, and still asks for anything else", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const askFile = join(dataDir, "ask.json");
  const cli = join(dataDir, "ask-pi.mjs");
  const writeAsk = (command: string) => writeFileSync(askFile, JSON.stringify({ command }));
  writeAsk("");
  // Every boot of the fake pi answers a prompt carrying MARKER with a bash confirm naming ask.json's command.
  writeFileSync(cli, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    `const ask = JSON.parse(readFileSync(${JSON.stringify(askFile)}, "utf8"));`,
    `process.env.FAKE_PI_PERMISSION_ON = ${JSON.stringify(MARKER)};`,
    'process.env.FAKE_PI_CONFIRM_TITLE = "Allow bash?";',
    "process.env.FAKE_PI_CONFIRM_MESSAGE = JSON.stringify({ command: ask.command });",
    `await import(${JSON.stringify(new URL("./testing/fake-pi-cli.ts", import.meta.url).href)});`,
  ].join("\n"), { mode: 0o700 });

  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).bots.find((entry: { id: string }) => entry.id === botId)?.busy === true;
  /** One turn in a thread of its own that asks about `command`: the card left for the person, if any, and whether the
   * turn is still waiting on it. The fake asks every confirmation with the same id ("ask-1"), so only this thread's rows
   * are read. */
  const turnAsking = async (bot: { id: string }, command: string) => {
    writeAsk(command);
    const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: command.slice(0, 60) }, 201);
    const thread = created.task.threadId as string;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: MARKER }, 202))).toBeTruthy();
    // The turn ends in one of two ways: the server answered the dialog itself (the bot's own lines follow), or the dialog
    // became the person's card and the turn waits on it.
    await expect.poll(async () => (await messages(thread)).some((message) => message.role === "bot"), { timeout: 20_000 }).toBe(true);
    // A card is written a moment before the turn is marked busy, so give the turn a beat to settle either way.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const rows = await messages(thread);
    const card = rows.find((message) => message.card?.requestId === "ask-1")?.card;
    const waiting = await busy(bot.id);
    if (waiting) {
      const stopped = await fetch(`${url}/api/bots/${bot.id}/interrupt`, { method: "POST",
        headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ threadId: thread }) });
      expect(stopped.status, "the person can stop the turn").toBeLessThan(300);
      await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
    }
    return { card, waiting, thread };
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Own files fixture", soul: "Answer plainly." }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    // Point the instance at the wrapper, as the desktop app's settings do when a person picks a CLI.
    await api("PATCH", `/api/instances/pi`, { cli });
    // A soul written through the bot's settings mirrors SOUL.md into its own folder, which is what a read is checked against.
    await api("PATCH", `/api/bots/${bot.id}`, { soul: "Answer plainly, and read your own notes first." });
    const own = join(dataDir, "workspaces", bot.id);
    const revision = join(own, "skills", ".revisions", "a".repeat(64));
    mkdirSync(revision, { recursive: true });
    writeFileSync(join(revision, "SKILL.md"), "# Morning email\n");
    writeFileSync(join(own, "MEMORY.md"), "notes\n");
    const soul = join(dataDir, "bots", bot.id, "SOUL.md");
    await expect.poll(async () => { try { return readFileSync(soul, "utf8").length > 0; } catch { return false; } },
      { timeout: 10_000 }).toBe(true);

    // Each of these only reads the bot's own files: the server answers the dialog itself, and no card is ever left.
    for (const command of [
      `cat ${soul}`,
      `head -n 20 ${join(revision, "SKILL.md")}`,
      `grep -rn "notes" ${own}`,
      `cat ${join(own, "MEMORY.md")}`,
    ]) {
      const answered = await turnAsking(bot, command);
      expect(answered.card, `${command} asks nobody`).toBeUndefined();
      expect(answered.waiting, `${command} lets the turn finish`).toBe(false);
    }
    // The decision log is written fire-and-forget, so its rows arrive a moment after the turns.
    await expect.poll(async () => {
      const decisions = (await api("GET", "/api/decisions")).decisions as Array<{ source?: string; decision?: string }>;
      return decisions.filter((row) => row.source === "own-files" && row.decision === "auto-approved").length;
    }, { timeout: 10_000 }).toBe(4);

    // A read of anything else, or a command that does more than read, is the person's to answer.
    for (const command of [
      `cat ${join(dataDir, "config.json")}`,
      `cat ${soul} | sh`,
    ]) {
      const asked = await turnAsking(bot, command);
      expect(asked.card, `${command} asks the person`).toMatchObject({ requestType: "permission", tool: "bash" });
      expect(asked.card.answered, `${command} is nobody's answer yet`).toBeUndefined();
      expect(asked.waiting, "the turn waits for the answer").toBe(true);
    }
  } finally {
    await fixture.close();
  }
}, 120_000);

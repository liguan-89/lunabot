import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { piDumpPath, piTurns } from "./testing/pi-dump.ts";

it("hands the rewound history to a pi turn once, through the real server route", async () => {
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  const evidence: unknown[] = [];
  try {
    fixture = await launchVerificationServer();
    const api = fixtureApi(fixture.info.url);
    const cli = async (...args: string[]) => {
      const result = await runControlLunabot([...args, "--url", fixture!.info.url]) as any;
      evidence.push({ command: args, result });
      return result;
    };
    const { bot } = await cli("new-bot", "--name", "Native replay fixture");
    const wait = async () => expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20")).status).toBe("settled");
    for (const text of ["NATIVE_REPLAY_SENTINEL", "Second request"]) {
      await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
      await wait();
    }
    const transcript = await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "30");
    const second = transcript.messages.find((message: any) => message.role === "user" && message.text === "Second request");
    expect(second?.id).toBeTruthy();
    await api("POST", `/api/bots/${bot.id}/messages/${second.id}/edit`, { threadId: bot.activeTaskId, text: "Revised second request" });
    await wait();
    const turns = piTurns(piDumpPath(fixture.info.dataDir));
    evidence.push({ turns });
    expect(turns).toHaveLength(3);
    // pi resumes its session between turns, so the rewind's prompt is the one place the whole history lands.
    const outgoing = turns.at(-1)!.prompt;
    expect(outgoing).toContain("rewound this conversation");
    expect(outgoing.split("NATIVE_REPLAY_SENTINEL").length - 1).toBe(1);
    expect(outgoing).toContain("Revised second request");
    expect(outgoing).not.toContain("Second request");
    await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "30");
  } finally {
    if (fixture) {
      const evidencePath = `${fixture.info.logPath}.native-replay.json`;
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.info(`Native replay evidence: ${evidencePath}`);
      await fixture.close();
    }
  }
}, 60_000);

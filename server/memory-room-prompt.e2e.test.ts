// Against the real server: the two prompts are assembled in two places, and only the assembled bytes prove they agree.
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { piDumpPath, piInstructionsFor, piTurnText, piTurns } from "./testing/pi-dump.ts";

it("gives a room turn the memory_update guidance, not the file-tools one", async () => {
  const fixture = await launchVerificationServer();
  const env = { LUNABOT_URL: fixture.info.url };
  const dumpPath = piDumpPath(fixture.info.dataDir);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as { [key: string]: unknown };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  /** The instructions in effect on the last turn whose prompt holds `text`, and its own words beside them. */
  const turnHolding = (text: string) => {
    const turns = piTurns(dumpPath);
    const index = turns.findLastIndex((turn) => turn.prompt.includes(text));
    return index < 0 ? null : { instructions: piInstructionsFor(turns, index), words: piTurnText(turns[index]!) };
  };
  try {
    // SAFETY: control-omb returns the created bot record under `bot`
    const { bot: lead } = await runControlOmb(["new-bot", "--name", "Lead"], { env }) as { bot: { id: string } };
    // SAFETY: same shape as above
    const { bot: helper } = await runControlOmb(["new-bot", "--name", "Helper"], { env }) as { bot: { id: string } };
    // A 1:1 turn first: it is the reference the room turn must match.
    await runControlOmb(["send", "--bot", lead.id, "--text", "Remember that the fixture garden is watered on Mondays."], { env });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const direct = turnHolding("the fixture garden is watered on Mondays");
    expect(direct, "the 1:1 turn's dump").not.toBeNull();
    expect(direct!.instructions).toContain("Change MEMORY.md only with memory_update");
    expect(direct!.instructions).not.toContain("update it with your file tools");

    // SAFETY: the groups route returns the created room under `group`
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    }) as { group: { id: string } };
    await api("POST", `/api/groups/${group.id}/messages`, { text: "Lead, what day is the garden watered?" });
    await expect.poll(() => turnHolding("what day is the garden watered") !== null, { timeout: 30_000 }).toBe(true);
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });
    const room = turnHolding("what day is the garden watered")!;
    // The room's own words carry the tail; pi sends the standing instructions once, on the session's first turn.
    expect(room.words).toContain("Reply to the conversation above as");
    expect(room.instructions).toContain("Change MEMORY.md only with memory_update");
    expect(room.instructions).not.toContain("update it with your file tools");
  } finally {
    await fixture.close();
  }
}, 120_000);

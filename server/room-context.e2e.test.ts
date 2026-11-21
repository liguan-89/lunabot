// Room context on the fixture's fake pi. pi now reports a context-window reading (the fake reports 12 of
// 128000 tokens), so `memberContext` fills and a member compact request is accepted. What stays below the
// fold threshold (90%) never times a compaction by itself; the Claude-only threshold subtests were removed
// with that engine rather than faked. The other fixtures still covered here are the room transcript
// carry-over (each room turn is handed the room's transcript) and the warm-process rule behind per-member
// readings (another member's turn in the same room thread replaces the previous member's warm pi child and
// drops its reading).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";
import { piDumpPath, piTurnText, piTurnsForThread, type PiTurn } from "./testing/pi-dump.ts";

const botOf = (turn: PiTurn): string | undefined => turn.launch?.mcpConfig?.mcpServers?.agents?.env?.OMB_BOT_ID;

it("carries the room's transcript into each warm pi turn, and reports no member context to measure", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const post = (path: string, body: unknown = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bot = (await control("new-bot", "--name", "Editor") as { bot: Pick<WireBot, "id" | "name"> }).bot;
    const other = (await control("new-bot", "--name", "Outsider") as { bot: Pick<WireBot, "id"> }).bot;
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { reply: "Edited." } }));
    const room = (await control("new-channel", "--name", "Edit bay", "--members", bot.id) as { channel: Pick<WireGroup, "id"> & { activeTaskId: string } }).channel;
    const read = async () => ((await (await fetch(url + "/api/bots?messages=0")).json()) as { groups: WireGroup[] })
      .groups.find(group => group.id === room.id)!;
    const send = async (text: string) => {
      await control("send-channel", "--channel", room.id, "--text", `@Editor ${text}`);
      expect(await control("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    };
    const dumpPath = piDumpPath(dataDir);
    const turns = () => piTurnsForThread(dumpPath, room.activeTaskId);

    // No turn has run yet, so there is nothing measured for the route to compact.
    expect((await post(`/api/groups/${room.id}/members/${bot.id}/compact`)).status).toBe(409);
    expect((await post(`/api/groups/${room.id}/members/${other.id}/compact`)).status).toBe(404);

    await send("Cut the intro.");
    await send("Trim the middle.");
    await expect.poll(() => turns().length, { timeout: 15_000 }).toBe(2);
    const [first, second] = turns();
    // The room's transcript reaches each turn, and the warm child keeps its process.
    expect(piTurnText(first!)).toContain("@Editor Cut the intro.");
    expect(piTurnText(first!)).not.toContain("@Editor Trim the middle.");
    expect(piTurnText(second!)).toContain("@Editor Cut the intro.");
    expect(piTurnText(second!)).toContain("Edited.");
    expect(piTurnText(second!)).toContain("@Editor Trim the middle.");
    expect(second!.launch?.pid).toBe(first!.launch?.pid);
    // pi reports its context usage, so the member's reading is recorded — and a compact request is taken.
    expect((await read()).memberContext).toMatchObject({ [bot.id]: { tokens: 12, window: 128000 } });
    expect((await post(`/api/groups/${room.id}/members/${bot.id}/compact`)).status).toBe(202);
  } finally { await fixture.close(); }
}, 90_000);

it("replaces a member's warm pi process when another member takes a room turn", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  try {
    const first = (await control("new-bot", "--name", "Editor") as { bot: Pick<WireBot, "id"> }).bot;
    const second = (await control("new-bot", "--name", "Cutter") as { bot: Pick<WireBot, "id"> }).bot;
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [first.id]: { reply: "Edited." }, [second.id]: { reply: "Cut." } }));
    const room = (await control("new-channel", "--name", "Edit bay", "--members", `${first.id},${second.id}`) as { channel: Pick<WireGroup, "id"> & { activeTaskId: string } }).channel;
    const read = async () => ((await (await fetch(url + "/api/bots?messages=0")).json()) as { groups: WireGroup[] })
      .groups.find(group => group.id === room.id)!;
    const send = async (text: string) => {
      await control("send-channel", "--channel", room.id, "--text", text);
      expect(await control("wait", "--channel", room.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    };
    const dumpPath = piDumpPath(dataDir);
    const turnsFor = (botId: string) => piTurnsForThread(dumpPath, room.activeTaskId)
      .filter((turn) => botOf(turn) === botId);

    await send("@Editor Cut the intro.");
    await expect.poll(() => turnsFor(first.id).length, { timeout: 15_000 }).toBe(1);
    // Another member's turn in the same room thread boots a different child (the agents env names the bot),
    // so the driver closes Editor's warm process, and the same dispatch drops its context reading.
    await send("@Cutter Trim the middle.");
    await expect.poll(() => turnsFor(second.id).length, { timeout: 15_000 }).toBe(1);
    await send("@Editor Tighten the outro.");
    await expect.poll(() => turnsFor(first.id).length, { timeout: 15_000 }).toBe(2);
    const editorTurns = turnsFor(first.id);
    expect(editorTurns[1]!.launch?.pid).not.toBe(editorTurns[0]!.launch?.pid);
    expect(turnsFor(second.id)[0]!.launch?.pid).not.toBe(editorTurns[0]!.launch?.pid);
    // Cutter's reading was displaced when Editor took the thread back; only the last member's stays.
    expect((await read()).memberContext).toMatchObject({ [first.id]: { tokens: 12, window: 128000 } });
  } finally { await fixture.close(); }
}, 90_000);

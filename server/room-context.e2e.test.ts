// Room context on the fixture's fake pi. The pi engine reports no provider context-window measurement, so the
// server never records a room member's context: `memberContext` stays null and the 90%-threshold fold has
// nothing to time. The Claude-only subtests that measured it — "compacts on request, and compacts before a
// turn above the threshold" (driven by FAKE_CLAUDE_CONTEXT_TOKENS) and "drops a member's reading once another
// member's turn replaces its warm process" (a reading pi never has) — were removed with that engine rather
// than faked. What the fixture can still drive is the product's room context carry-over (each room turn is
// handed the room's transcript) and the warm-process rule behind the retired per-member reading (another
// member's turn in the same room thread replaces the previous member's warm pi child).
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

    // pi does not report a context-window measurement, so there is nothing for the route to compact yet.
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
    // Two complete turns measured nothing: pi reports usage, not a context-window reading.
    expect((await read()).memberContext).toBeNull();
    expect((await post(`/api/groups/${room.id}/members/${bot.id}/compact`)).status).toBe(409);
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
    // so the driver closes Editor's warm process. The retired per-member context reading was dropped on the
    // same dispatch; pi has no reading, but the warm-process rule behind it is still observable.
    await send("@Cutter Trim the middle.");
    await expect.poll(() => turnsFor(second.id).length, { timeout: 15_000 }).toBe(1);
    await send("@Editor Tighten the outro.");
    await expect.poll(() => turnsFor(first.id).length, { timeout: 15_000 }).toBe(2);
    const editorTurns = turnsFor(first.id);
    expect(editorTurns[1]!.launch?.pid).not.toBe(editorTurns[0]!.launch?.pid);
    expect(turnsFor(second.id)[0]!.launch?.pid).not.toBe(editorTurns[0]!.launch?.pid);
    // Nothing was measured, so nothing is retained or shown for either member.
    expect((await read()).memberContext).toBeNull();
  } finally { await fixture.close(); }
}, 90_000);

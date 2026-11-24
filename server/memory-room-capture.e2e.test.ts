// Against the real server: the room's eligibility and the turn it reads are assembled in server/index.ts. pi's driver has
// no one-shot text call, so the capture call is reached and refused with the reason upkeep gives (NO_TEXT_ENGINE); what a
// room turn writes into memory is its own daily log, through the agents proxy. The retired Codex recipe went with the
// other engines: this build runs one, and its background call is the same one pi has (none).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLunabot } from "../scripts/control-lunabot.ts";
import type { WireBot } from "../shared/wire.ts";
import { NO_TEXT_ENGINE } from "./memory-upkeep.ts";

it("queues a member bot's room turn for capture only once Learn from group chats is on, and says why no model step runs", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-capture-"));
  const fixture = await launchVerificationServer({ ...process.env });
  const env = { LUNABOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const upkeep = (botId: string) => api<{ enabled: boolean; modelSteps: boolean; lastCapture?: { note?: string } }>(`/api/bots/${botId}/memory/upkeep`);
  try {
    // The one engine this build runs makes no background text call, and every bot's status says so.
    const { instances } = await api<{ instances: Array<{ instanceId: string; capabilities: { backgroundText?: boolean } }> }>("/api/instances");
    expect(instances.map((instance) => instance.instanceId)).toEqual(["pi"]);
    expect(instances[0]!.capabilities.backgroundText).toBe(false);

    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead" });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    expect(await upkeep(lead.id)).toMatchObject({ enabled: true, modelSteps: false });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    expect((await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config")).features?.roomMemoryCapture).toBe(false);
    const config = await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config", "PATCH", { features: { roomMemoryCapture: true } });
    expect(config.features?.roomMemoryCapture).toBe(true);

    const { group } = await api<{ group: { id: string; threadId: string } }>("/api/groups", "POST", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the garden launch moved to Friday." });
    await runControlLunabot(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    // The room's turn is queued for capture and reaches the call; with no background call it stops there and says why.
    await expect.poll(async () => (await upkeep(lead.id)).lastCapture?.note ?? null, { timeout: 30_000 }).toBe(NO_TEXT_ENGINE);
    expect((await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text)
      .not.toContain("The garden launch moved to Friday");

    // What a room turn does write is its own daily log, sourced to the room, through the real agents proxy.
    await expect.poll(async () => (await api<{ entries: Array<{ path: string; actor: string; via: string; threadId?: string }> }>(`/api/bots/${lead.id}/memory/journal`)).entries
      .filter((entry) => entry.path.startsWith("memory/log/")), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ actor: "bot", via: "turn", threadId: group.threadId })]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

it("leaves a room turn out of memory upkeep entirely while Learn from group chats is off", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-capture-off-"));
  const fixture = await launchVerificationServer({ ...process.env });
  const env = { LUNABOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  try {
    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead" });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    expect((await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config")).features?.roomMemoryCapture).toBe(false);

    const { group } = await api<{ group: { id: string } }>("/api/groups", "POST", {
      name: "Quiet room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the garden launch moved to Friday." });
    await runControlLunabot(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    // Nothing is queued at all: not even a call to refuse, so the status keeps no capture report.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await api<{ lastCapture?: unknown }>(`/api/bots/${lead.id}/memory/upkeep`)).lastCapture).toBeUndefined();
    expect((await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text)
      .not.toContain("The garden launch moved to Friday");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

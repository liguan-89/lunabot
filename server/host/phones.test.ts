// Where the person is comes from where the turn came from, never from asking them: a send one of the owner's phones made
// is the phone's, the person at the computer works the usual way, and a run nobody typed is unattended. Shared servers
// and other people's sessions get no phone.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Route } from "../../shared/route-replay.ts";
import type { CloudLendingTurn } from "../cloud-lending.ts";
import { PHONE_PLACE_PROMPT } from "../phones/instructions.ts";
import { ownerDirectoryName } from "../phone-routes.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhones, type Phones, type PhonesDeps } from "./phones.ts";

const THREAD = "thread-1";
const TURN = { botId: "chief", threadId: THREAD, generation: "gen-1" };
const PHONE_SESSION = { id: "phone-session", label: "Omkar's iPhone" } as SessionRecord;
const DESK_SESSION = { id: "desk-session", label: "Laptop" } as SessionRecord;
const session = (record: SessionRecord): RequestAuth => ({ kind: "session", session: record, via: "bearer", scopes: ["admin", "client"] });
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const chief = { id: "chief", name: "Luna Bot", color: "teal", chiefOfStaff: true } as BotRecord;

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function world(overrides: Partial<PhonesDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-phones-host-"));
  dirs.push(dir);
  // The owner's iPhone, paired as a session, allowing Calendar.
  writeFileSync(join(dir, "phones.json"), JSON.stringify({ version: 1, phones: [{
    key: `session:${PHONE_SESSION.id}`, owner: "owner", registeredAt: 1, seen: Date.now(), lastUsedAt: null,
    registration: { installId: "install-0001", name: "Omkar's iPhone", platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" } },
  }] }));
  const lines: Array<{ id: string; role: string; text?: string; sendId?: string; sender?: { id: string } }> = [];
  const requests = new Map<string, { messageId?: string; automation?: unknown; origin?: { kind: string } }>();
  const phones = createPhones({
    dataDir: dir, shared: false, cloudHome: false, cloudOwnerKey: null, loopbackTrust: "owner", sharedMembership: () => false,
    store: { messagesFor: () => lines, bot: () => chief, groupByThread: () => undefined, appendMessage: () => {} } as unknown as PhonesDeps["store"],
    sessions: { list: () => [], isLive: () => true, onSessionRevoked: () => () => {} }, routines: () => null, ownerOrAdmin: (auth) => auth.scopes.includes("admin"), cloudOwnerSession: () => false,
    smsOwners: () => [],
    cloudLendingRefusal: () => null,
    cloudLendingTurn: () => ({ thread: lines, request: { ...requests.get(THREAD), generations: new Set([TURN.generation]) }, generation: TURN.generation, starters: [], reportsFromOthers: false,
      ownerPerson: () => true, cardAnswerer: () => undefined, routineRun: () => null }) as unknown as CloudLendingTurn,
    originIsUser: () => true, request: (threadId) => requests.get(threadId), nudge: () => {}, mint: () => "turn-token",
    harnessUrl: "http://127.0.0.1:1", active: () => true,
    ...overrides,
  });
  /** A person's line in the thread and the direct request it starts. */
  const send = (sendId: string, request: { automation?: unknown; origin?: { kind: string } } = { origin: { kind: "user" } }, sender?: string, text?: string) => {
    const id = `line-${lines.length + 1}`;
    lines.push({ id, role: "user", sendId, ...(text ? { text } : {}), ...(sender ? { sender: { id: sender } } : {}) });
    requests.set(THREAD, { messageId: id, ...request });
  };
  return { phones, send, dir };
}

describe("where the person is", () => {
  it("a send from the owner's phone is the phone's; the same words typed at the computer stay at the computer", () => {
    const { phones, send } = world();
    // The phone's send: its id was noted when the phone made it.
    send(phones.sendIdFor(session(PHONE_SESSION)));
    expect(phones.place(THREAD, true)).toBe("phone");
    // At the computer (this machine, or a paired laptop that is no phone): the usual way, never the phone's place.
    send(phones.sendIdFor(loopback));
    expect(phones.place(THREAD, true)).toBe("computer");
    send(phones.sendIdFor(session(DESK_SESSION)));
    expect(phones.place(THREAD, true)).toBe("computer");
    // A send id the computer chose itself is not the phone's, though a phone made one before.
    send("desk-send-000000000001");
    expect(phones.place(THREAD, true)).toBe("computer");
    phones.noteSend("phone-send-00000000001");
    send("phone-send-00000000001");
    expect(phones.place(THREAD, true)).toBe("phone");
  });

  it("a turn nobody typed is unattended, whatever line it answers", () => {
    const { phones, send } = world();
    send("desk-send-000000000002", { automation: { routineId: "r1" }, origin: { kind: "user" } });
    expect(phones.place(THREAD, true)).toBe("unattended");
    send("desk-send-000000000003", { origin: { kind: "outside" } });
    expect(phones.place(THREAD, true)).toBe("unattended");
    send("desk-send-000000000004");
    expect(phones.place(THREAD, false)).toBe("unattended");
    expect(phones.place("no-such-thread", true)).toBe("unattended");
  });

  it("a mounted turn is told where the person is, and no place asks them to choose", async () => {
    const { phones, send } = world();
    send(phones.sendIdFor(loopback));
    for (const place of ["phone", "computer", "unattended"] as const) {
      const [device, where] = await phones.promptParts(chief, { mounted: true, offered: true, turn: TURN, place });
      expect(device).toMatchObject({ id: "device", label: "Phone", text: expect.stringContaining("Omkar's iPhone is an iPhone; this bot may use: Calendar.") });
      expect(where).toEqual({ id: "device-place", label: "Where the person is", text: PHONE_PLACE_PROMPT[place] });
    }
    for (const text of Object.values(PHONE_PLACE_PROMPT)) {
      expect(text).not.toMatch(/here or on (their|your) phone|ask (once|them|the person|whether)|\?/iu);
    }
    expect(PHONE_PLACE_PROMPT.computer).toContain("only when they name the phone; otherwise do it here.");
    expect(PHONE_PLACE_PROMPT.phone).toContain("do it on the phone with the PHONE tools");
    // Unmounted: why the owner's phone is not here, and no place at all.
    expect(await phones.promptParts(chief, { mounted: false, offered: true, turn: TURN, place: "phone" })).toEqual([
      { id: "device", label: "Phone", text: expect.stringContaining("Paired: Omkar's iPhone.") },
    ]);
    expect(await phones.promptParts(chief, { mounted: false, offered: false, turn: TURN, place: "phone" })).toEqual([{ id: "device", label: "Phone", text: "" }]);
  });
});

describe("whose phones", () => {
  it("only the owner's own requests and turns reach the desktop owner's phones", () => {
    const { phones, send } = world();
    expect(phones.fromPhone(session(PHONE_SESSION))).toBe(true);
    expect(phones.fromPhone(session(DESK_SESSION))).toBe(false);
    expect(phones.fromPhone(loopback)).toBe(false);
    // No request this turn can prove: no phone.
    expect(phones.turnOwner(TURN)).toBeNull();
    send(phones.sendIdFor(loopback));
    expect(phones.turnOwner(TURN)).toBe("owner");
    expect(phones.integration(chief, TURN)).toMatchObject({ env: { OMB_MCP_TOKEN_DEVICE: "turn-token", OMB_HARNESS_URL: "http://127.0.0.1:1" } });
    // A line from a person who holds no admin session here is not the owner's, nor is anything after it.
    send("guest-send-0000000001", { origin: { kind: "user" } }, "p_guest");
    expect(phones.turnOwner(TURN)).toBeNull();
    expect(phones.integration(chief, TURN)).toBeNull();
  });

  it("a number listed in sms.owners texts in as the owner; any other number stays a stranger", () => {
    const { phones, send } = world({ smsOwners: () => ["+8613800000000"] });
    // An sms: sender id is `sms:<phoneKey>|<number>` — the owner's listed number reaches the phone's tools.
    send("sms-send-000000000001", { origin: { kind: "user" } }, `sms:session:${PHONE_SESSION.id}|+8613800000000`);
    expect(phones.turnOwner(TURN)).toBe("owner");
    expect(phones.integration(chief, TURN)).toMatchObject({ env: { OMB_MCP_TOKEN_DEVICE: "turn-token", OMB_HARNESS_URL: "http://127.0.0.1:1" } });
    // An unlisted number is nobody's owner.
    send("sms-send-000000000002", { origin: { kind: "user" } }, `sms:session:${PHONE_SESSION.id}|+8613999999999`);
    expect(phones.turnOwner(TURN)).toBeNull();
    expect(phones.integration(chief, TURN)).toBeNull();
  });

  it("sms.owners match on digit suffix — the country code may sit on either side", () => {
    const { phones, send } = world({ smsOwners: () => ["13800000000"] });
    send("sms-send-000000000009", { origin: { kind: "user" } }, `sms:session:${PHONE_SESSION.id}|+8613800000000`);
    expect(phones.turnOwner(TURN)).toBe("owner");
  });

  it("without sms.owners an SMS sender is never the owner", () => {
    const { phones, send } = world();
    send("sms-send-000000000003", { origin: { kind: "user" } }, `sms:session:${PHONE_SESSION.id}|+8613800000000`);
    expect(phones.turnOwner(TURN)).toBeNull();
  });

  it("a Team Cloud or hosted workspace, a server several people sign in to, and a service-trust machine get no phone", async () => {
    for (const overrides of [{ shared: true }, { sharedMembership: () => true }, { loopbackTrust: "service" as const }]) {
      const { phones, send } = world(overrides);
      send(phones.sendIdFor(loopback));
      expect(phones.fromPhone(session(PHONE_SESSION))).toBe(true);
      expect(phones.turnOwner(TURN)).toBeNull();
      expect(phones.integration(chief, TURN)).toBeNull();
      expect(phones.previewParts(chief, true)).toEqual([]);
      expect(await phones.promptParts(chief, { mounted: false, offered: true, turn: TURN, place: "computer" })).toEqual([{ id: "device", label: "Phone", text: "" }]);
    }
  });

  it("on a Cloud home only the owner's session holds a phone, and only a turn the lent Mac would allow reaches it", () => {
    let refusal: string | null = null;
    const { phones } = world({ cloudHome: true, cloudOwnerKey: "owner", cloudOwnerSession: (auth) => auth.kind === "session" && auth.session.id === PHONE_SESSION.id, cloudLendingRefusal: () => refusal });
    expect(phones.turnOwner(TURN)).toBe("owner");
    refusal = "someone-else";
    expect(phones.turnOwner(TURN)).toBeNull();
    expect(phones.integration(chief, TURN)).toBeNull();
  });
});

describe("Mika's intent gate over a fitting route", () => {
  const REQUEST = "帮我在备忘录里打开第 2 页";
  /** A stored route whose template the request fits, so the gate has a candidate to answer for. */
  const seedRoute = (dir: string) => {
    const owner = join(dir, "phone-routes", ownerDirectoryName("owner"));
    mkdirSync(owner, { recursive: true });
    const route: Route = {
      id: "r1", template: "帮我在备忘录里打开{1}", slots: 1, packages: [], appVersions: {},
      steps: [{ tool: "PHONE_UI_TAP", args: { ref: "e1" }, target: null, before: { packageName: null, texts: [] }, after: { packageName: null, texts: [] } }],
      successes: 0, consecutiveMisses: 0, missStep: null, disabled: false, lastUsedMs: 0,
    };
    writeFileSync(join(owner, "r1.json"), JSON.stringify(route));
  };
  /** A decision call that answers the gate's question, and counts how often it was asked. */
  const decider = (choice: "DISCUSS" | "READ" | "ACT") => {
    const gate = {
      calls: 0,
      choose: async () => {
        gate.calls += 1;
        return { ok: true as const, provider: "jev" as const, latencyMs: 1, answers: { type: "choice" as const, choice, pTop: 0.9, margin: 0.5, probabilities: { [choice]: 0.9 } } };
      },
    };
    return gate;
  };
  const routePart = async (phones: Phones, turn = TURN) =>
    (await phones.promptParts(chief, { mounted: true, offered: true, turn, place: "computer" })).find((part) => part.id === "device-route");

  it("a discussion keeps the recorded path out of the prompt; a read or act verdict is told it", async () => {
    for (const [choice, shown] of [["DISCUSS", false], ["READ", true], ["ACT", true]] as const) {
      const gate = decider(choice);
      const { phones, send, dir } = world({ decider: gate as unknown as PhonesDeps["decider"] });
      seedRoute(dir);
      send("desk-send-0000000100", { origin: { kind: "user" } }, undefined, REQUEST);
      const part = await routePart(phones);
      if (shown) expect(part?.text).toContain("帮我在备忘录里打开{1}");
      else expect(part?.text ?? "").toBe("");
      expect(gate.calls).toBe(1);
    }
  });

  it("asks the gate at most once a turn, and again on the next", async () => {
    const gate = decider("READ");
    const { phones, send, dir } = world({ decider: gate as unknown as PhonesDeps["decider"] });
    seedRoute(dir);
    send("desk-send-0000000200", { origin: { kind: "user" } }, undefined, REQUEST);
    await routePart(phones);
    await routePart(phones);
    expect(gate.calls).toBe(1);
    await routePart(phones, { ...TURN, generation: "gen-2" });
    expect(gate.calls).toBe(2);
  });

  it("never spends the question on a turn that is not the person's own, nor on a request with nothing to replay", async () => {
    const gate = decider("DISCUSS");
    const { phones, send, dir } = world({ decider: gate as unknown as PhonesDeps["decider"], originIsUser: () => false });
    seedRoute(dir);
    send("desk-send-0000000300", { origin: { kind: "user" } }, undefined, REQUEST);
    expect((await routePart(phones))?.text).toContain("帮我在备忘录里打开{1}");
    expect(gate.calls).toBe(0);

    const fresh = decider("DISCUSS");
    const empty = world({ decider: fresh as unknown as PhonesDeps["decider"] });
    empty.send("desk-send-0000000400", { origin: { kind: "user" } }, undefined, REQUEST);
    await routePart(empty.phones);
    expect(fresh.calls).toBe(0);
  });

  it("with neither a decider nor a judge wired there is no gate — the route is offered as before", async () => {
    const { phones, send, dir } = world();
    seedRoute(dir);
    send("desk-send-0000000500", { origin: { kind: "user" } }, undefined, REQUEST);
    expect((await routePart(phones))?.text).toContain("帮我在备忘录里打开{1}");
  });

  it("the judge answers when the decision call cannot", async () => {
    const failing = { calls: 0, choose: async () => (failing.calls += 1, { ok: false as const, reason: "timeout" as const }) };
    const { phones, send, dir } = world({ decider: failing as unknown as PhonesDeps["decider"], verify: () => async () => "DISCUSS" });
    seedRoute(dir);
    send("desk-send-0000000600", { origin: { kind: "user" } }, undefined, REQUEST);
    expect((await routePart(phones))?.text ?? "").toBe("");
    expect(failing.calls).toBe(1);
  });
});

describe("pushed notices", () => {
  const phoneAuth = session(PHONE_SESSION);
  const notice = (extra: Record<string, unknown> = {}) => ({
    kind: "notice", key: "n1", packageName: "com.chat.app", postedAtMs: 1_000, title: "Alex", text: "到了吗", ...extra,
  });
  /** A /api/phones/self or /self/events call on the routes the host built, with the body already read. */
  const call = async (phones: Phones, method: string, path: string, body?: unknown) => {
    let status = 0;
    let payload: unknown;
    await phones.routes({
      req: { headers: { "content-type": "application/json" } } as never,
      res: { setHeader: () => {} } as never,
      url: new URL(`http://x${path}`), path, method, auth: phoneAuth,
      json: (_res: never, code: number, data: unknown) => { status = code; payload = data; return undefined as never; },
      readBody: async () => body as never,
    } as never);
    return { status, payload };
  };
  /** The phone re-declares its grants and the ticked packages, over the seeded registration. */
  const enroll = async (phones: Phones, noticeApps: string[] = ["com.chat.app"], capabilities: Record<string, string> = { phoneData: "full" }) => {
    const out = await call(phones, "PUT", "/api/phones/self", {
      installId: "install-0001", name: "Omkar's iPhone", platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata",
      capabilities, noticeApps,
    });
    expect(out.status).toBe(200);
  };

  it("keeps a whitelisted notice in the owner's inbox and only there", async () => {
    const { phones } = world();
    await enroll(phones);
    expect((await call(phones, "POST", "/api/phones/self/events", notice())).status).toBe(202);
    const inbox = phones.noticeInbox("owner");
    expect(inbox?.records.map((record) => record.packageName)).toEqual(["com.chat.app"]);
    expect(inbox?.kept).toBe(1);
    expect(phones.noticeInbox("someone-else")).toBeNull();
  });

  it("drops a package the person never ticked, a sensitive post, and a reposted copy", async () => {
    const { phones } = world();
    await enroll(phones);
    expect((await call(phones, "POST", "/api/phones/self/events", notice({ packageName: "com.other.app" }))).status).toBe(202);
    expect((await call(phones, "POST", "/api/phones/self/events", notice({ key: "n2", text: "验证码 482913" }))).status).toBe(202);
    expect((await call(phones, "POST", "/api/phones/self/events", notice())).status).toBe(202);
    const inbox = phones.noticeInbox("owner");
    expect(inbox?.kept).toBe(1);
    expect(inbox?.received).toBe(2);
  });

  it("an unticked package loses its kept records on the next event", async () => {
    const { phones } = world();
    await enroll(phones, ["com.chat.app", "com.other.app"]);
    await call(phones, "POST", "/api/phones/self/events", notice());
    await call(phones, "POST", "/api/phones/self/events", notice({ key: "n2", packageName: "com.other.app", text: "ping" }));
    expect(phones.noticeInbox("owner")?.kept).toBe(2);
    await enroll(phones, ["com.chat.app"]);
    expect((await call(phones, "POST", "/api/phones/self/events", notice({ key: "n3", text: "again" }))).status).toBe(202);
    const left = phones.noticeInbox("owner")?.records.map((record) => record.packageName) ?? [];
    expect(left).toHaveLength(2);
    expect(new Set(left)).toEqual(new Set(["com.chat.app"]));
  });

  it("does not reach the sms or wechat relays, and needs the phoneData grant", async () => {
    const { phones } = world();
    const seen: string[] = [];
    phones.onSmsEvent(() => seen.push("sms"));
    phones.onWechatEvent(() => seen.push("wechat"));
    await enroll(phones, ["com.chat.app"], { messages: "full" });
    expect((await call(phones, "POST", "/api/phones/self/events", notice())).status).toBe(403);
    await enroll(phones);
    expect((await call(phones, "POST", "/api/phones/self/events", notice())).status).toBe(202);
    expect(seen).toEqual([]);
    expect(phones.noticeInbox("owner")?.kept).toBe(1);
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";

import { personKey } from "./person-key.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRecord } from "./sessions.ts";
import { writeMemberExport, type MemberExportDeps } from "./member-export.ts";
import { createMeExportRoutes } from "./routes/me-export.ts";
import { extractZip, readZipDirectory } from "./zip-archive.ts";

const ADA = personKey({ id: "", email: "ada@example.com" });
const BOB = personKey({ id: "", email: "bob@example.com" });

function session(email: string): SessionRecord {
  return { id: "s1", email, membershipAuthority: "team", teamRole: "member" } as unknown as SessionRecord;
}
const asSession = (record: SessionRecord): RequestAuth => ({ kind: "session", session: record, via: "bearer", scopes: ["client"] }) as unknown as RequestAuth;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-member-export-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

interface FixtureOptions {
  threads?: Record<string, Array<Record<string, unknown>>>;
  ownBot?: boolean;
  routineHomePerson?: string | null;
}

function fixture(opts: FixtureOptions = {}) {
  const threads = opts.threads ?? {
    "t-private": [
      { id: "m1", role: "user", kind: "text", text: "hello there", sender: { id: ADA, name: "Ada" } },
      { id: "m2", role: "bot", kind: "text", text: "general reply", from: { name: "LunaBot" } },
      { id: "m3", role: "user", kind: "text", text: "a branched-off edit", sender: { id: ADA, name: "Ada" } },
    ],
  };
  writeFileSync(join(dir, "bots.json"), JSON.stringify(opts.ownBot === false ? [] : [
    { id: "b-own", threadId: "t-own", defaultBot: { person: "ada@example.com" }, tasks: [{ threadId: "t-own-task", title: "Own task" }] },
    { id: "b-shared", threadId: "t-shared" },
  ]));
  writeFileSync(join(dir, "groups.json"), JSON.stringify([{ threadId: "t-room", tasks: [{ threadId: "t-room-task" }] }]));
  writeFileSync(join(dir, "routines.json"), JSON.stringify({
    version: 1,
    routines: [
      { id: "r-mine", botId: "b-own", name: "mine", sourceThreadId: "t-private" },
      { id: "r-team", botId: "b-shared", name: "team", sourceThreadId: "t-room" },
    ],
    runs: [
      { id: "run-1", routineId: "r-mine", threadId: "t-private" },
      { id: "run-2", routineId: "r-team", threadId: "t-room" },
    ],
  }));
  mkdirSync(join(dir, "people", ADA), { recursive: true });
  writeFileSync(join(dir, "people", ADA, "about.json"), JSON.stringify({ version: 1, aboutMe: "Ada likes tea." }));
  writeFileSync(join(dir, "people", ADA, "uploads.json"), JSON.stringify(["upload-unsent.pdf"]));
  writeFileSync(join(dir, "person-inbox.json"), JSON.stringify({ version: 1, homes: { [ADA]: { botId: "b-own", threadId: "t-own" } }, items: [{ person: ADA, text: "for ada" }, { person: BOB, text: "for bob" }] }));
  const layer = `b-own--member-${ADA}`;
  mkdirSync(join(dir, "workspaces", layer, "memory"), { recursive: true });
  writeFileSync(join(dir, "workspaces", layer, "MEMORY.md"), "# memory of ada");
  writeFileSync(join(dir, "workspaces", layer, "memory", "facts.md"), "fact one");
  mkdirSync(join(dir, "attachments"), { recursive: true });
  writeFileSync(join(dir, "attachments", "upload-unsent.pdf"), Buffer.from([1, 2, 3, 4]));
  writeFileSync(join(dir, "attachments", "chat-file.png"), Buffer.from([5, 6, 7]));
  threads["t-private"].push({ id: "m4", role: "user", kind: "text", text: "see /attachments/chat-file.png", sender: { id: ADA, name: "Ada" } });
  const deps: MemberExportDeps = {
    dataDir: dir,
    threadsOf: (person) => (person === ADA ? ["t-private", "t-room"] : []),
    messagesFor: (threadId) => threads[threadId] ?? [],
    ownBotPerson: (bot) => {
      const inner = bot.defaultBot as { person?: string } | undefined;
      return inner?.person ? personKey({ id: "", email: inner.person }) : null;
    },
    routineHome: (routine) => (opts.routineHomePerson !== undefined ? opts.routineHomePerson : routine.id === "r-mine" ? ADA : null),
    threadTitle: () => "Ada's chat",
    speaker: () => "Ada",
  };
  return { deps, layer };
}

async function unzipEntries(zipPath: string): Promise<Map<string, string>> {
  const out = mkdtempSync(join(tmpdir(), "omb-member-export-read-"));
  try {
    await extractZip(zipPath, out, { maxEntries: 500 });
    const entries = new Map<string, string>();
    const members = await readZipDirectory(zipPath, 500);
    for (const member of members) {
      const file = join(out, member.name);
      try { entries.set(member.name, readFileSync(file, "utf8")); } catch { entries.set(member.name, "<unreadable>"); }
    }
    return entries;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe("writeMemberExport", () => {
  it("packs the member's private threads with every branch, memory, me files, routines and attachments", async () => {
    const { deps, layer } = fixture();
    const zipPath = join(dir, "out.zip");
    const count = writeMemberExport(ADA, zipPath, deps);
    expect(count).toBeGreaterThan(5);
    const entries = await unzipEntries(zipPath);
    const names = [...entries.keys()];
    expect(names.some((n) => n.startsWith("threads/") && n.endsWith(".json"))).toBe(true);
    expect(names.some((n) => n.startsWith("threads/") && n.endsWith(".md"))).toBe(true);
    const threadJson = JSON.parse(entries.get(names.find((n) => n.endsWith(".json") && n.startsWith("threads/"))!)!);
    expect(threadJson.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(entries.get(`memory/${layer}/MEMORY.md`)).toBe("# memory of ada");
    expect(entries.get(`memory/${layer}/memory/facts.md`)).toBe("fact one");
    expect(JSON.parse(entries.get("me/about.json")!).aboutMe).toBe("Ada likes tea.");
    expect(JSON.parse(entries.get("me/uploads.json")!)).toEqual(["upload-unsent.pdf"]);
    const inbox = JSON.parse(entries.get("me/inbox.json")!);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].text).toBe("for ada");
    const routines = JSON.parse(entries.get("routines.json")!);
    expect(routines.routines.map((r: { id: string }) => r.id)).toEqual(["r-mine"]);
    expect(routines.runs.map((r: { id: string }) => r.id)).toEqual(["run-1"]);
    expect(entries.has("attachments/upload-unsent.pdf")).toBe(true);
    expect(entries.has("attachments/chat-file.png")).toBe(true);
    expect(entries.has("README.md")).toBe(true);
  });

  it("leaves a shared room out even when the starter list names it", async () => {
    const { deps } = fixture();
    const zipPath = join(dir, "out.zip");
    writeMemberExport(ADA, zipPath, deps);
    const entries = await unzipEntries(zipPath);
    const names = [...entries.keys()];
    const threadJsons = names.filter((n) => n.startsWith("threads/") && n.endsWith(".json"));
    // t-private + own bot 线程（t-own/t-own-task 无消息仍导出条目）；room 线程不在
    expect(threadJsons.every((n) => !n.includes("t-room"))).toBe(true);
  });
});

describe("me-export routes", () => {
  async function call(route: ReturnType<typeof createMeExportRoutes>, auth: RequestAuth, path: string, method: string) {
    const parsed = new URL(`http://x${path}`);
    const answer: { status?: number; headers?: Record<string, string>; body?: unknown; bytes?: Buffer } = {};
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const res = sink as unknown as ServerResponse & { writeHead(status: number, sent: Record<string, string>): void };
    res.writeHead = (status: number, sent: Record<string, string>) => { answer.status = status; answer.headers = sent; };
    sink.on("finish", () => { answer.bytes = Buffer.concat(chunks); });
    const json = ((_res: ServerResponse, status: number, body: unknown) => { answer.status = status; answer.body = body; }) as never;
    await route({ req: { headers: {} } as IncomingMessage, res, url: parsed, path: parsed.pathname, method, auth, json, readBody: (async () => ({})) as never });
    return answer;
  }

  it("POST builds an export and GET streams it to the same person only", async () => {
    const { deps } = fixture();
    const route = createMeExportRoutes({ ...deps, session: (auth) => (auth.kind === "session" ? auth.session : null) });
    const created = await call(route, asSession(session("ada@example.com")), "/api/me/export", "POST");
    expect(created.status).toBe(200);
    const url = (created.body as { url: string }).url;
    expect(url).toMatch(/^\/api\/me\/export\/[\w-]{36}\.zip$/);
    expect((created.body as { entries: number }).entries).toBeGreaterThan(5);
    const own = await call(route, asSession(session("ada@example.com")), url, "GET");
    expect(own.status).toBe(200);
    expect(own.headers?.["content-type"]).toBe("application/zip");
    expect(own.bytes?.length).toBeGreaterThan(200);
    expect(own.bytes?.subarray(0, 2).toString()).toBe("PK");
    const other = await call(route, asSession(session("bob@example.com")), url, "GET");
    expect(other.status).toBe(404);
    const noSession = await call(route, { kind: "loopback" } as unknown as RequestAuth, url, "GET");
    expect(noSession.status).toBe(403);
  });

  it("refuses POST without a session", async () => {
    const { deps } = fixture();
    const route = createMeExportRoutes({ ...deps, session: () => null });
    const answer = await call(route, { kind: "loopback" } as unknown as RequestAuth, "/api/me/export", "POST");
    expect(answer.status).toBe(403);
  });
});

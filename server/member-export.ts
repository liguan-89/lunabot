// Everything one Team Cloud member carries out: their private chats (every branch, attachments included), their memory
// layers, their about-you and profile, the routines that live in their private chats with their runs, the files they
// uploaded and never sent, and their inbox entries. The set is the same one team-member-left.ts deletes when they go —
// what is one member's alone, never a room's or the team's. Exporting copies, it never deletes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeZipFile, type ZipWriteEntry } from "./zip-write.ts";

const PERSON = /^p_[\w-]{22}$/;

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(record) : []);
function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export interface MemberExportDeps {
  dataDir: string;
  /** The threads this person opened themselves (thread-starters), newest first. */
  threadsOf(person: string): string[];
  /** Every message row of a thread, all branches (store.messagesFor). */
  messagesFor(threadId: string): Row[];
  /** The person whose own LunaBot this bot is, else null. */
  ownBotPerson(bot: Row): string | null;
  /** The person whose private chat this routine lives in (routine-home), else null. */
  routineHome(routine: Row): string | null;
  /** Display title for a thread, for file names. */
  threadTitle(threadId: string): string;
  /** The display name of one line's speaker in a thread (speakerOf semantics). */
  speaker(threadId: string, msg: Row): string;
}

interface MemberData {
  threads: string[];
  bots: Row[];
  attachments: Set<string>;
  layers: string[];
  routines: Row[];
  runs: Row[];
}

/** The threads, bots, layers, attachments and routines that are this member's alone. */
export function memberDataSet(person: string, deps: MemberExportDeps): MemberData {
  const rooms = new Set<string>();
  for (const group of rows(readJson(join(deps.dataDir, "groups.json")))) {
    if (typeof group.threadId === "string") rooms.add(group.threadId);
    for (const task of rows(group.tasks)) if (typeof task.threadId === "string") rooms.add(task.threadId);
  }
  const threads = new Set<string>();
  for (const threadId of deps.threadsOf(person)) if (!rooms.has(threadId)) threads.add(threadId);
  const bots: Row[] = [];
  for (const bot of rows(readJson(join(deps.dataDir, "bots.json")))) {
    if (deps.ownBotPerson(bot) !== person || typeof bot.id !== "string") continue;
    bots.push(bot);
    if (typeof bot.threadId === "string") threads.add(bot.threadId);
    for (const task of rows(bot.tasks)) if (typeof task.threadId === "string") threads.add(task.threadId);
  }
  const attachments = new Set<string>();
  const scan = (threadId: string) => {
    for (const hit of JSON.stringify(deps.messagesFor(threadId)).matchAll(/attachments\/([\w.-]+)/g)) attachments.add(hit[1]);
  };
  for (const threadId of threads) scan(threadId);
  for (const name of memberUploadsList(deps.dataDir, person)) attachments.add(name);
  const layers = memoryLayersOf(deps.dataDir, person);
  const stored = readJson(join(deps.dataDir, "routines.json"));
  const routines: Row[] = [];
  const runs: Row[] = [];
  if (record(stored)) {
    for (const routine of rows(stored.routines)) if (deps.routineHome(routine) === person) routines.push(routine);
    const kept = new Set(routines.map((routine) => routine.id));
    for (const run of rows(stored.runs)) if (kept.has(run.routineId)) runs.push(run);
    for (const routine of routines) {
      for (const attachment of rows(routine.attachments)) {
        if (typeof attachment.path === "string") {
          const name = /([^/]+)$/.exec(attachment.path)?.[1];
          if (name) attachments.add(name);
        }
      }
    }
  }
  return { threads: [...threads], bots, attachments, layers, routines, runs };
}

function memberUploadsList(dataDir: string, person: string): string[] {
  const names = readJson(join(dataDir, "people", person, "uploads.json"));
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

function memoryLayersOf(dataDir: string, person: string): string[] {
  const root = join(dataDir, "workspaces");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`--member-${person}`) && !entry.name.includes(".."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const safeName = (value: string) => (value.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);

function* threadFiles(person: string, data: MemberData, deps: MemberExportDeps): Generator<ZipWriteEntry> {
  for (const threadId of data.threads) {
    const title = deps.threadTitle(threadId);
    const base = `threads/${safeName(title)}-${threadId.slice(0, 8)}`;
    const messages = deps.messagesFor(threadId).map(({ png: _png, mime: _mime, ...rest }) => rest);
    yield { name: `${base}.json`, data: JSON.stringify({ name: title, threadId, person, messages }, null, 2) };
    const lines: string[] = [`# ${title}`, ""];
    for (const msg of deps.messagesFor(threadId)) {
      const who = msg.role === "user" ? deps.speaker(threadId, msg) : typeof msg.from === "object" && msg.from !== null && typeof (msg.from as Row).name === "string" ? (msg.from as Row).name as string : "Bot";
      if ((msg.kind === "text" || msg.kind === "widget" || msg.kind === "app") && typeof msg.text === "string" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
      else if (msg.kind === "activity" && record(msg.tool) && typeof msg.tool.name === "string") lines.push(`> ${msg.tool.name}`, "");
      else if (msg.kind === "screen") lines.push("> [screen capture]", "");
    }
    yield { name: `${base}.md`, data: lines.join("\n") };
  }
}

function* memoryFiles(dataDir: string, layers: readonly string[]): Generator<ZipWriteEntry> {
  for (const layer of layers) {
    const root = join(dataDir, "workspaces", layer);
    const memory = join(root, "MEMORY.md");
    if (existsSync(memory)) yield { name: `memory/${layer}/MEMORY.md`, data: readFileSync(memory) };
    const dir = join(root, "memory");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) yield { name: `memory/${layer}/memory/${entry.name}`, data: readFileSync(join(dir, entry.name)) };
    }
  }
}

function jsonEntry(name: string, value: unknown): ZipWriteEntry | null {
  return value === null || value === undefined ? null : { name, data: JSON.stringify(value, null, 2) };
}

/** Writes the member's export zip at `out`, returning how many entries it holds. */
export function writeMemberExport(person: string, out: string, deps: MemberExportDeps): number {
  if (!PERSON.test(person)) throw new Error("not a person key");
  const data = memberDataSet(person, deps);
  const entries: ZipWriteEntry[] = [];
  entries.push({ name: "README.md", data: [
    "# Luna Bot data export",
    "",
    "Everything of yours this Team Cloud kept: your private conversations (every branch, JSON and markdown),",
    "your memory layers, your profile and about-you, the routines living in your private chats with their runs,",
    "your unsent uploads and inbox entries, and the files those conversations and routines use (attachments/).",
    "",
    `Exported for ${person} at ${new Date().toISOString()}.`,
    "",
  ].join("\n") });
  entries.push(...threadFiles(person, data, deps));
  entries.push(...memoryFiles(deps.dataDir, data.layers));
  for (const file of ["about.json", "profile.json", "uploads.json"]) {
    const value = readJson(join(deps.dataDir, "people", person, file));
    const entry = jsonEntry(`me/${file}`, value);
    if (entry) entries.push(entry);
  }
  const inbox = readJson(join(deps.dataDir, "person-inbox.json"));
  if (record(inbox)) {
    const mine = {
      home: record(inbox.homes) ? inbox.homes[person] ?? null : null,
      items: rows(inbox.items).filter((item) => item.person === person),
    };
    entries.push({ name: "me/inbox.json", data: JSON.stringify(mine, null, 2) });
  }
  entries.push({ name: "routines.json", data: JSON.stringify({ routines: data.routines, runs: data.runs }, null, 2) });
  const root = join(deps.dataDir, "attachments");
  return writeZipFile(out, (function* (): Generator<ZipWriteEntry> {
    yield* entries;
    for (const name of [...data.attachments].sort()) {
      if (name.includes("/") || name.includes("..")) continue;
      const file = join(root, name);
      if (!existsSync(file)) continue;
      yield { name: `attachments/${name}`, data: readFileSync(file), method: 0 };
    }
  })());
}

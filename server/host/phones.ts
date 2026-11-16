// The owner's paired phones as bot tools, wired once by server/index.ts: the registry and the jobs a phone polls, which
// sends came from a phone, whose turn may reach the phones, what a turn mounts and is told, and the /api/phones routes.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { extensionForFileMime, extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImage } from "../attachments.ts";

import { cloudHomeLendingRefusal, createCloudRoutineAuthors, type CloudLendingTurn } from "../cloud-lending.ts";
import { personKey } from "../person-key.ts";
import type { PhoneBot, PhonePlace } from "../phones/access.ts";
import { createPhoneHost, type PhoneHostDeps, type PhoneOutboundHoldAnswer, type PhoneOutboundHoldInput } from "../phones/host.ts";
import { PHONE_SEND_TIMEOUT_MS, PhoneJobs } from "../phones/jobs.ts";
import { adoptExistingRoutines, desktopLendingTurn, desktopPhonesOffered } from "../phones/owner.ts";
import { PhoneRegistry } from "../phones/registry.ts";
import { createPhoneSends } from "../phones/sends.ts";
import type { LoopbackTrust, RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";
import { createPhoneRoutes, PHONE_ACCESS_CHANGED, phoneKey } from "../routes/phones.ts";
import { PHONE_REPLY_SMS, type PhoneEvent } from "../sms-relay.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { BotRecord, Store } from "../store.ts";
import type { PromptPart } from "../system-prompt.ts";

type Turn = { botId: string; threadId: string; generation: string };

/** The owner of a desktop's phones: whoever works at this machine or holds an admin session. */
const DESKTOP_OWNER = "owner";

/** Saves a phone file into the attachment store; the caller appends the message row. */
const savePhoneAttachment: NonNullable<PhoneHostDeps["saveAttachment"]> = async ({ name, mime, bytes }) => {
  // A NUL is stripped with replaceAll rather than a character class: a control character in a regex literal is a lint error.
  const safeName = name.replace(/[\\/]/g, "_").replaceAll("\u0000", "_").trim().slice(0, 200) || "file";
  if (extensionForMime(mime)) {
    if (bytes.byteLength > IMAGE_MAX_BYTES) return { ok: false, text: `这张图片超过 ${Math.round(IMAGE_MAX_BYTES / 1_048_576)} MB，没有放进对话。` };
    const saved = saveImage(bytes, mime);
    return { ok: true, attachment: { kind: "image" as const, path: saved.path, mime: saved.mime, name: safeName } };
  }
  if (!extensionForFileMime(mime)) return { ok: false, text: "这个文件类型不能作为附件放进对话。" };
  if (bytes.byteLength > FILE_MAX_BYTES) return { ok: false, text: "文件超过了附件大小上限。" };
  const saved = await saveFile(Readable.from(bytes), safeName, mime, { expectedBytes: bytes.byteLength });
  return { ok: true, attachment: { kind: "file" as const, path: saved.path, mime: saved.mime, name: saved.name } };
};

export interface PhonesDeps {
  dataDir: string;
  /** A Team Cloud or a hosted workspace: several people share it, so no phone is anyone's. */
  shared: boolean;
  cloudHome: boolean;
  /** The Cloud home owner's key; null off a Cloud home. */
  cloudOwnerKey: string | null;
  loopbackTrust: LoopbackTrust;
  sharedMembership(): boolean;
  store: Pick<Store, "appendMessage" | "bot" | "groupByThread" | "messagesFor">;
  sessions: Pick<SessionRegistry, "list" | "isLive" | "onSessionRevoked">;
  routines(): { listRoutines(): Routine[] } | null;
  ownerOrAdmin(auth: RequestAuth): boolean;
  cloudOwnerSession(auth: RequestAuth): boolean;
  /** Numbers whose SMS turns count as the owner's (cfg.sms.owners); caller-ID is the whole claim. */
  smsOwners(): string[];
  /** The lent-Mac test on a Cloud home: null when the turn may use the owner's things. */
  cloudLendingRefusal(turn: Turn): string | null;
  cloudLendingTurn(turn: Turn): CloudLendingTurn;
  /** The harness's record says this turn's work came from the user. */
  originIsUser(turn: Turn): boolean;
  /** The thread's latest direct request: the line it answers, a routine's trigger, where its work came from. */
  request(threadId: string): { messageId?: string; automation?: unknown; origin?: { kind: string } } | undefined;
  /** Nudges the owner's open apps: a job is waiting for a phone. */
  nudge(frame: { kind: "device.job"; phone: string; id: string }): void;
  /** Mints the turn's device capability. */
  mint(botId: string, turn: { threadId: string; generation: string }): string;
  harnessUrl: string;
  active(turn: Turn): boolean;
  /** Screen writes hold for the same outgoing-action card a connected-app send does. */
  holdPhoneOutbound?(input: PhoneOutboundHoldInput): Promise<PhoneOutboundHoldAnswer>;
  /** The turn's effective approval mode, read at call time; absent is `ask`, so every screen write waits. */
  approvalMode?(botId: string, threadId: string): string;
}

export type Phones = ReturnType<typeof createPhones>;

export function createPhones(deps: PhonesDeps) {
  const { store } = deps;
  const registry = new PhoneRegistry(join(deps.dataDir, "phones.json"));
  const sends = createPhoneSends();
  const jobs = new PhoneJobs((phone, id) => deps.nudge({ kind: "device.job", phone, id }));
  const unsubscribe = deps.sessions.onSessionRevoked((id) => {
    const key = `session:${id}`;
    try { registry.remove(key); } catch {}
    jobs.drop(key, PHONE_ACCESS_CHANGED);
  });
  const ownerRoutinesFile = join(deps.dataDir, "owner-routines.json");
  const routineRecordsExisted = existsSync(ownerRoutinesFile);
  /** Off a Cloud home: the routines the desktop owner wrote, so their runs and reports keep the owner's phones. */
  const routineAuthors = deps.cloudHome ? null : createCloudRoutineAuthors(ownerRoutinesFile);
  const desktopPhones = () => desktopPhonesOffered({ sharedMembership: deps.sharedMembership(), loopbackTrust: deps.loopbackTrust });
  /** Whose phones this server offers at all, before any turn is looked at. */
  const owner = () => (deps.shared ? null : deps.cloudHome ? deps.cloudOwnerKey : desktopPhones() ? DESKTOP_OWNER : null);

  function ownerOf(auth: RequestAuth): string | null {
    if (deps.shared) return null;
    if (deps.cloudHome) return deps.cloudOwnerSession(auth) ? deps.cloudOwnerKey : null;
    return desktopPhones() && deps.ownerOrAdmin(auth) ? DESKTOP_OWNER : null;
  }

  /** Whose phones a turn may use: on a Cloud home the owner's, when the lent Mac would allow the turn; elsewhere the desktop owner's. */
  function turnOwner(turn: Turn): string | null {
    if (deps.shared) return null;
    if (deps.cloudHome) return deps.cloudLendingRefusal(turn) === null ? deps.cloudOwnerKey : null;
    if (!desktopPhones()) return null;
    const lending = desktopLendingTurn({ ...deps.cloudLendingTurn(turn), thread: store.messagesFor(turn.threadId) }, {
      adminPersons: () => {
        const persons = new Set(deps.sessions.list().filter((session) => session.scopes.includes("admin")).map((session) => personKey(session)));
        // An sms: sender id is `sms:<phoneKey>|<number>`; a number in sms.owners texts in as the owner.
        // Dialing forms differ (+86 138… vs 138…) so numbers compare on digit suffix, not the literal string.
        const numbers = deps.smsOwners().map((n) => n.replace(/\D/g, "")).filter((n) => n.length >= 7);
        if (numbers.length) for (const line of store.messagesFor(turn.threadId)) {
          const id = line.sender?.id ?? "";
          if (!id.startsWith("sms:")) continue;
          const num = id.slice(id.lastIndexOf("|") + 1).replace(/\D/g, "");
          if (num.length >= 7 && numbers.some((n) => num === n || num.endsWith(n) || n.endsWith(num))) persons.add(id);
        }
        return persons;
      },
      originIsUser: () => deps.originIsUser(turn),
      ownerWrote: (id) => {
        const routine = deps.routines()?.listRoutines().find((candidate) => candidate.id === id);
        return Boolean(routine && routineAuthors?.authored(routine.id, routine));
      },
    });
    return cloudHomeLendingRefusal(lending) === null ? DESKTOP_OWNER : null;
  }

  /** The SMS relay's inbound hook, installed after channels are built. */
  let smsHandler: ((key: string, event: PhoneEvent) => void) | undefined;

  const fromPhone = (auth: RequestAuth): boolean => {
    const key = phoneKey(auth);
    return key !== null && registry.get(key) !== undefined;
  };

  const host = createPhoneHost({
    registry, jobs, dataDir: deps.dataDir, bot: (id) => store.bot(id), turnOwner,
    inRoom: (threadId) => Boolean(store.groupByThread(threadId)),
    appendMessage: (threadId, message) => { store.appendMessage(threadId, message as Parameters<typeof store.appendMessage>[1]); },
    active: deps.active,
    holdOutbound: deps.holdPhoneOutbound,
    approvalMode: deps.approvalMode,
    saveAttachment: savePhoneAttachment,
  });

  return {
    routineAuthors,
    fromPhone,
    noteSend: (sendId: string) => sends.note(sendId),
    /** A fresh send id, known as the phone's when one of the owner's registered phones made the send. */
    sendIdFor(auth: RequestAuth): string {
      const sendId = randomUUID().replaceAll("-", "");
      if (fromPhone(auth)) sends.note(sendId);
      return sendId;
    },
    turnOwner,
    /** Where the person is, from where the turn came from: the phone's send, the person at the computer, or nobody. */
    place(threadId: string, personAsked: boolean): PhonePlace {
      const request = deps.request(threadId);
      const line = request?.messageId ? store.messagesFor(threadId).find((message) => message.id === request.messageId) : undefined;
      if (sends.has(line?.sendId)) return "phone";
      return personAsked && !request?.automation && request?.origin?.kind === "user" ? "computer" : "unattended";
    },
    /** Only for the owner's own turn and a bot granted an app one of the owner's phones allows. */
    integration(bot: BotRecord, turn: { threadId: string; generation: string }) {
      return host.integration(bot, turnOwner({ botId: bot.id, ...turn }), () => deps.mint(bot.id, turn), deps.harnessUrl);
    },
    /** A turn's phone parts: what it may use and where the person is, or (unmounted) why the owner's phone is not here. */
    promptParts(bot: PhoneBot, input: { mounted: boolean; offered: boolean; turn: Turn; place: PhonePlace }): PromptPart[] {
      if (input.mounted) return host.parts(bot, turnOwner(input.turn), input.place);
      return [{ id: "device", label: "Phone", text: input.offered ? host.withheld(bot, owner()) : "" }];
    },
    /** The bot settings preview: the owner's phone as a turn at the computer would see it. */
    previewParts(bot: PhoneBot, offered: boolean): PromptPart[] {
      const phoneOwner = owner();
      return offered && host.mounts(bot, phoneOwner) ? host.parts(bot, phoneOwner, "computer") : [];
    },
    handle: host.handle,
    toolListing: host.toolListing,
    routes: createPhoneRoutes({ registry, jobs, owner: ownerOf, isAdmin: deps.ownerOrAdmin, live: (auth) => auth.kind !== "session" || deps.sessions.isLive(auth.session.id), onEvent: (key, event) => smsHandler?.(key, event) }),
    /** The SMS relay installs itself here once channels exist. */
    onSmsEvent: (handler: (key: string, event: PhoneEvent) => void) => { smsHandler = handler; },
    /** A channel reply the phone sends itself as SMS; only ever goes to the number that wrote in. */
    replySms: async (key: string, to: string, text: string) => {
      const outcome = await jobs.request(key, PHONE_REPLY_SMS, { to, text }, {
        active: () => true, timeoutMs: PHONE_SEND_TIMEOUT_MS,
        offlineText: "This phone is offline. Open the Luna Bot app on it.", online: () => registry.online(key),
      });
      if (outcome.ok) registry.used(key);
      return outcome;
    },
    /** How many phones run the phone app here. */
    paired: (): number => registry.list(null, () => false).length,
    /** Routines written before records were kept are the owner's on a single-person desktop: record them once. */
    adoptRoutines() {
      if (!routineAuthors) return;
      adoptExistingRoutines({
        recordsExisted: routineRecordsExisted, offered: desktopPhones(),
        otherPeople: deps.sessions.list().some((session) => !session.scopes.includes("admin")),
        routines: deps.routines()?.listRoutines() ?? [],
        record: (routine) => routineAuthors.record(routine.id, routine), persist: () => routineAuthors.persist(),
      });
    },
    /** Anyone else's edit makes the routine no longer the owner's; the owner's keeps or renews it. */
    routineEdited(auth: RequestAuth, routine: Routine, ownersAgain: boolean) {
      if (!routineAuthors) return;
      if (!deps.ownerOrAdmin(auth)) routineAuthors.forget(routine.id);
      else if (ownersAgain) routineAuthors.record(routine.id, routine);
    },
    close: () => { unsubscribe(); jobs.close(); },
  };
}

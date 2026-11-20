// The owner's paired phones as bot tools, wired once by server/index.ts: the registry and the jobs a phone polls, which
// sends came from a phone, whose turn may reach the phones, what a turn mounts and is told, and the /api/phones routes.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { extensionForFileMime, extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImage } from "../attachments.ts";

import { cloudHomeLendingRefusal, createCloudRoutineAuthors, type CloudLendingTurn } from "../cloud-lending.ts";
import { createNoticeDedup, NoticeInbox, noticeRecordOf, sanitizeNotice, shouldLearn, shouldLearnPackage, type NoticeDedupStore, type NoticePolicy, type NoticeSnapshot } from "../phone-notices.ts";
import { createNoticeTriage, type NoticeSurfacedItem, type NoticeTriage } from "./notice-triage.ts";
import type { Decider } from "../decider/index.ts";
import { assessIntent, INTENT_GATE_TIMEOUT_MS, intentGateRequest, MAX_CONTEXT_TURNS, type Intent } from "../intent-gate.ts";
import { personKey } from "../person-key.ts";
import type { PhoneBot, PhonePlace } from "../phones/access.ts";
import { createPhoneHost, verifyPhoneTurn, verifyPrompt, type PhoneHostDeps, type PhoneOutboundHoldAnswer, type PhoneOutboundHoldInput, type PhoneTurnEnd, type PhoneTurnEnded } from "../phones/host.ts";
import { PHONE_SEND_TIMEOUT_MS, PhoneJobs } from "../phones/jobs.ts";
import { adoptExistingRoutines, desktopLendingTurn, desktopPhonesOffered } from "../phones/owner.ts";
import { PhoneRegistry } from "../phones/registry.ts";
import { createPhoneSends } from "../phones/sends.ts";
import { PhoneSteer } from "../phones/steer.ts";
import { PhoneRoutes } from "../phone-routes.ts";
import type { LoopbackTrust, RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";
import { createPhoneRoutes, PHONE_ACCESS_CHANGED, phoneKey } from "../routes/phones.ts";
import { PHONE_REPLY_SMS, type PhoneEvent } from "../sms-relay.ts";
import { PHONE_REPLY_WECHAT, type WechatEvent } from "../wechat-relay.ts";
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
  /**
   * The intent gate's decision call (server/intent-gate.ts). With neither this nor `verify` wired there is no gate,
   * exactly as Mika without an IntentGate: a fitting route is offered and every call runs.
   */
  decider?: Pick<Decider, "choose">;
  /**
   * A plain one-off text call on the bot's engine; null when the engine cannot make one. The answer check calls it
   * only when that check is on (its mode beside it in server/phones/host.ts); the intent gate calls it as its judge
   * when the decision call could not answer.
   */
  verify?(botId: string): ((prompt: string) => Promise<string>) | null;
  /** The check's mode, read at call time from Settings; absent is `off`, so nothing is checked. */
  verifyMode?: () => "off" | "log";
  /**
   * The notice triage's judge: a plain text call on the owner's chief bot's engine (Mika uses a general chat model,
   * never the decision model). Absent is no triage — notices are still learned into the inbox.
   */
  noticeJudge?(ownerKey: string): ((prompt: string) => Promise<string>) | null;
  /** The batch the judge said was worth interrupting for; index.ts turns it into a thread the person sees. */
  noticeSurfaced?(ownerKey: string, packageName: string, items: NoticeSurfacedItem[]): void;
  /** Triage reasons are written in this language's English name. */
  noticeLanguage?(): string;
}

export type Phones = ReturnType<typeof createPhones>;

export function createPhones(deps: PhonesDeps) {
  const { store } = deps;
  const registry = new PhoneRegistry(join(deps.dataDir, "phones.json"));
  const sends = createPhoneSends();
  const jobs = new PhoneJobs((phone, id) => deps.nudge({ kind: "device.job", phone, id }));
  /** A person's mid-turn words stop a job being waited on; the job itself keeps running on the phone. */
  const steer = new PhoneSteer();
  /** The routes a turn's phone calls walked: recorded on by default, offered for reuse only where a caller asks. */
  const phoneRoutes = new PhoneRoutes({ root: join(deps.dataDir, "phone-routes"), enabled: true });
  /** A person's own request, judged at most once a turn — Mika's gate: the verdict, null when the answer could not
   * be read, undefined when the gate does not apply. The route part and the call gate share one lazy promise. */
  const intents = new Map<string, Promise<Intent | null | undefined>>();
  /** The route a turn's prompt carried, so `endTurn` can settle it against the calls the turn actually ran. */
  const routeOffers = new Map<string, { ownerKey: string; id: string }>();
  /** Each owner's learned-notice pile: a bounded inbox, the dedup that keeps reposts from filling it, and its triage. */
  const noticeInboxes = new Map<string, { inbox: NoticeInbox; dedup: NoticeDedupStore; triage: NoticeTriage }>();
  const noticeSinkFor = (ownerKey: string): { inbox: NoticeInbox; dedup: NoticeDedupStore; triage: NoticeTriage } => {
    let sink = noticeInboxes.get(ownerKey);
    if (!sink) {
      const inbox = new NoticeInbox();
      sink = {
        inbox,
        dedup: createNoticeDedup(),
        triage: createNoticeTriage({
          snapshot: () => inbox.snapshot(),
          judge: () => deps.noticeJudge?.(ownerKey) ?? null,
          // Mika's "a task is running": any job in flight to one of this owner's phones.
          busy: () => registry.list(ownerKey, () => false).some((phone) => jobs.busy(phone.key)),
          language: () => deps.noticeLanguage?.() ?? "English",
          surface: (packageName, items) => deps.noticeSurfaced?.(ownerKey, packageName, items),
          now: Date.now,
          wait: (ms, run) => setTimeout(run, ms),
          unwait: (handle) => clearTimeout(handle as NodeJS.Timeout),
        }),
      };
      noticeInboxes.set(ownerKey, sink);
      for (const stale of noticeInboxes.keys()) {
        if (noticeInboxes.size <= 16) break;
        noticeInboxes.delete(stale);
      }
    }
    return sink;
  };
  /**
   * A pushed notification is learned only inside the package list the person ticked on the phone — the phone filters
   * before posting and the registration declares the same list, so this check is a second reading of the same consent.
   */
  const noticeFor = (key: string, event: Extract<PhoneEvent, { kind: "notice" }>): void => {
    const phone = registry.get(key);
    if (!phone) return;
    const policy: NoticePolicy = { allow: new Set(phone.registration.noticeApps ?? []), listenerGranted: true };
    const record = sanitizeNotice(noticeRecordOf(event));
    if (shouldLearnPackage(record.packageName, policy) !== "keep") return;
    const sink = noticeSinkFor(phone.owner);
    // An unticked package stops being learned and its kept records go with it.
    sink.inbox.removePackages((pkg) => policy.allow.has(pkg));
    sink.inbox.noteReceived();
    if (shouldLearn(record, policy) !== "keep") return;
    if (sink.dedup.admit(record) === null) return;
    sink.inbox.add(record);
    sink.triage.poke();
  };
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

  /** The SMS and WeChat relays' inbound hooks, installed after channels are built. */
  let smsHandler: ((key: string, event: PhoneEvent) => void) | undefined;
  let wechatHandler: ((key: string, event: WechatEvent) => void) | undefined;

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
    steer,
    routes: phoneRoutes,
    verifyMode: deps.verifyMode ?? (() => "off"),
    intent: (turn) => intentFor(turn),
  });

  /** The line the thread's latest direct request answers, as the route recorder and the route part both read it. */
  const goalFor = (threadId: string): string => {
    const request = deps.request(threadId);
    const line = request?.messageId ? store.messagesFor(threadId).find((message) => message.id === request.messageId) : undefined;
    return line?.text ?? "";
  };

  const intentKey = (turn: Turn): string => `${turn.threadId}${turn.botId}${turn.generation}`;

  /**
   * Mika's scope for the question: only the person's own line is judged — a routine, an automation or a handoff is
   * never a discussion — and only where a decision model or a judge exists to answer. The judge prompt is the
   * gate's own question asked in prose, so either leg alone is a working gate.
   */
  async function assessTurn(turn: Turn): Promise<Intent | null | undefined> {
    if (!deps.originIsUser(turn)) return undefined;
    const decide = deps.decider;
    const complete = deps.verify?.(turn.botId) ?? null;
    if (!decide && !complete) return undefined;
    const request = deps.request(turn.threadId);
    const messages = request?.messageId === undefined ? [] : store.messagesFor(turn.threadId);
    const at = messages.findIndex((message) => message.id === request?.messageId);
    const message = (at < 0 ? "" : messages[at]?.text ?? "").trim();
    if (!message) return undefined;
    const recentContext = messages.slice(Math.max(0, at - MAX_CONTEXT_TURNS), at)
      .map((entry) => {
        const text = entry.text?.trim();
        return text ? `${entry.role}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
    const { state, question } = intentGateRequest({ message, recentContext });
    const judgeText = `${question.instructions}\n\ncurrentMessage: ${state.currentMessage}\n${state.recentContext ? `${state.recentContext}\n` : ""}\nAnswer with exactly one word: DISCUSS, READ, or ACT.`;
    // The judge borrows the answer check's text call, whose own budget is far wider: the gate's 10 s is imposed
    // around it, so a stalled engine never holds a turn — a timeout reads the same as no reply.
    const judged = complete
      ? async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race<string | null>([
              complete(judgeText).catch(() => null),
              new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INTENT_GATE_TIMEOUT_MS); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      : () => null;
    try {
      const { intent } = await assessIntent(
        () => decide?.choose("botDecide", state, question, { timeoutMs: INTENT_GATE_TIMEOUT_MS })
          ?? { ok: false as const, reason: "disabled" as const },
        judged,
      );
      return intent;
    } catch {
      return null;
    }
  }

  function intentFor(turn: Turn): Promise<Intent | null | undefined> {
    const key = intentKey(turn);
    const cached = intents.get(key);
    if (cached) return cached;
    const promise = assessTurn(turn);
    intents.set(key, promise);
    for (const stale of intents.keys()) {
      if (intents.size <= 64) break;
      intents.delete(stale);
    }
    return promise;
  }

  return {
    routineAuthors,
    fromPhone,
    steer,
    phoneRoutes,
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
    goalFor,
    /** Only for the owner's own turn and a bot granted an app one of the owner's phones allows. */
    integration(bot: BotRecord, turn: { threadId: string; generation: string }) {
      return host.integration(bot, turnOwner({ botId: bot.id, ...turn }), () => deps.mint(bot.id, turn), deps.harnessUrl);
    },
    /** A turn's phone parts: what it may use and where the person is, or (unmounted) why the owner's phone is not here. */
    async promptParts(bot: PhoneBot, input: { mounted: boolean; offered: boolean; turn: Turn; place: PhonePlace }): Promise<PromptPart[]> {
      if (!input.mounted) return [{ id: "device", label: "Phone", text: input.offered ? host.withheld(bot, owner()) : "" }];
      const phoneOwner = turnOwner(input.turn);
      const request = goalFor(input.turn.threadId);
      // Mika's order: the intent question is spent only where a route could actually be told — one fitting candidate.
      const matched = phoneOwner !== null && request !== "" ? phoneRoutes.match(phoneOwner, request) : [];
      const intent = matched.length === 1 ? await intentFor(input.turn) : undefined;
      const parts = host.parts(bot, phoneOwner, input.place, request, intent);
      // Only a route the prompt actually carries is owed the turn-end settle; the offer is spent once the turn ends.
      if (phoneOwner !== null && matched.length === 1 && parts.some((part) => part.id === "device-route" && part.text !== "")) {
        routeOffers.set(intentKey(input.turn), { ownerKey: phoneOwner, id: matched[0].id });
        for (const stale of routeOffers.keys()) {
          if (routeOffers.size <= 64) break;
          routeOffers.delete(stale);
        }
      }
      return parts;
    },
    /** The bot settings preview: the owner's phone as a turn at the computer would see it. */
    previewParts(bot: PhoneBot, offered: boolean): PromptPart[] {
      const phoneOwner = owner();
      return offered && host.mounts(bot, phoneOwner) ? host.parts(bot, phoneOwner, "computer") : [];
    },
    handle: host.handle,
    toolListing: host.toolListing,
    /** What this turn's phone calls read, for the answer check at turn end. */
    evidenceFor: host.evidenceFor,
    /**
     * The turn is over: learn its route when it earned one and hand its evidence back. Answers what the turn left
     * behind, so the caller can check the reply and log the route; never throws.
     */
    endTurn: (turn: Turn, input: PhoneTurnEnd): PhoneTurnEnded => {
      const key = intentKey(turn);
      intents.delete(key);
      const offeredRoute = routeOffers.get(key) ?? null;
      routeOffers.delete(key);
      // The owner is only worked out when there is something to learn, since that reads the thread's messages.
      const ownerKey = input.ownerKey ?? (host.evidenceFor(turn).length ? turnOwner(turn) : null);
      return host.endTurn(turn, { ...input, ownerKey, offeredRoute });
    },
    /**
     * The turn is over, for a caller that has only the bot and the settled reply: learn the route when it earned one,
     * and check the reply against the same evidence when the check is on. Fire-and-forget, so nothing here delays a
     * reply or throws; the goal comes from the thread's latest direct request, and only the person's own line counts.
     */
    turnEnded(turn: Turn, input: { reply: string; stopped: boolean }): void {
      const key = intentKey(turn);
      intents.delete(key);
      const offeredRoute = routeOffers.get(key) ?? null;
      routeOffers.delete(key);
      if (!store.bot(turn.botId)) return;
      const request = deps.request(turn.threadId);
      const goal = goalFor(turn.threadId);
      // A routine's run, a handoff and an unattended wake are nobody's own line: their calls are evidence, not a route.
      const personLine = request !== undefined && request.automation === undefined && request.origin?.kind === "user";
      const ended = host.endTurn(turn, { goal, stopped: input.stopped, spoiled: !personLine, offeredRoute });
      // The mode is asked for now, not captured at start-up: turning the switch on reaches the next turn that ends.
      const mode = host.verifyMode();
      const complete = mode === "off" || input.stopped || input.reply.trim() === "" ? null : deps.verify?.(turn.botId) ?? null;
      if (!complete) return;
      void verifyPhoneTurn({ dataDir: deps.dataDir, threadId: turn.threadId, mode, goal, reply: input.reply, evidence: ended.evidence, complete: async (messages) => complete(verifyPrompt(messages)) }).catch(() => {});
    },
    /**
     * The routes that fit a request, best first. Exposed for a later prompt part; nothing injects them yet, because a
     * bot told about a route would start trusting one before any replay exists to run it.
     */
    matchRoutes: (owner: string | null, request: string, limit?: number, packages?: readonly string[]) => phoneRoutes.match(owner, request, limit, packages),
    routes: createPhoneRoutes({ registry, jobs, owner: ownerOf, isAdmin: deps.ownerOrAdmin, live: (auth) => auth.kind !== "session" || deps.sessions.isLive(auth.session.id), onEvent: (key, event) => {
      if (event.kind === "notice") noticeFor(key, event);
      else if (event.kind === "sms") smsHandler?.(key, event);
      else wechatHandler?.(key, event);
    } }),
    /** The SMS relay installs itself here once channels exist. */
    onSmsEvent: (handler: (key: string, event: PhoneEvent) => void) => { smsHandler = handler; },
    /** The WeChat relay installs itself here once channels exist. */
    onWechatEvent: (handler: (key: string, event: WechatEvent) => void) => { wechatHandler = handler; },
    /** A channel reply the phone sends itself as SMS; only ever goes to the number that wrote in. */
    replySms: async (key: string, to: string, text: string) => {
      const outcome = await jobs.request(key, PHONE_REPLY_SMS, { to, text }, {
        active: () => true, timeoutMs: PHONE_SEND_TIMEOUT_MS,
        offlineText: "This phone is offline. Open the Luna Bot app on it.", online: () => registry.online(key),
      });
      if (outcome.ok) registry.used(key);
      return outcome;
    },
    /** A channel reply the phone sends itself as WeChat; only ever to the peer that wrote in, never a DM to anyone else. */
    replyWechat: async (key: string, to: string, text: string) => {
      const outcome = await jobs.request(key, PHONE_REPLY_WECHAT, { to, text }, {
        active: () => true, timeoutMs: PHONE_SEND_TIMEOUT_MS,
        offlineText: "This phone is offline. Open the Luna Bot app on it.", online: () => registry.online(key),
      });
      if (outcome.ok) registry.used(key);
      return outcome;
    },
    /** How many phones run the phone app here. */
    paired: (): number => registry.list(null, () => false).length,
    /** The notices one owner's phones pushed and the server kept, oldest first; null while nothing was learned. */
    noticeInbox(ownerKey: string): NoticeSnapshot | null {
      return noticeInboxes.get(ownerKey)?.inbox.snapshot() ?? null;
    },
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
    close: () => { unsubscribe(); jobs.close(); for (const sink of noticeInboxes.values()) sink.triage.stop(); },
  };
}

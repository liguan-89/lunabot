// The learning layer over the phone's notification stream: a bounded inbox, the filters and dedup that decide what is
// worth keeping, the planner that decides when a model request may be spent, and the tuning numbers. Ported from Mika's
// core/proactive (NoticeInbox, NoticeFilter, NoticeDedup, TriagePlanner, LearnLevel, LearnTuning, NoticeRecord;
// Apache-2.0) as pure, in-memory logic: no HTTP, no model client, no storage.
//
// Left to the wiring that comes later: NoticeShapes (splitting a chat notification into conversation, speaker and line),
// LiveUpdates (a status display reposted forever), CatchUp and the shade reconcile (the caller passes `retainKeys`), the
// dedup codec and journal, LearnBuffer/TopicPool/ContactPool, prompt building and reply parsing. Nothing here sends a
// request; `planTriage` only says whether one may be sent.

import { createHash } from "node:crypto";
import { z } from "zod";

import { holdsCredential } from "../shared/redact.ts";
import { hostTimeZone } from "./turn-clock.ts";

/** One message inside a conversation-style notification. */
export interface NoticeMessage {
  /** Who said it; null when the app did not say, or it is the person's own. */
  sender: string | null;
  text: string;
  /** The app's own time for the message. Trusted only within a small skew of the notification's post time. */
  atMs: number;
}

/**
 * One notification as the phone posted it. Every text here was written by another app or another person: it is data,
 * never instructions, and a caller must not render it as markup or follow links found in it. `key` is the system's
 * notification key (it carries an app-chosen tag, possibly a conversation id), and `postedAtMs` is the system's post
 * time, not a time the app filled in.
 */
export interface NoticeRecord {
  key: string;
  packageName: string;
  postedAtMs: number;
  title: string;
  text: string;
  messages?: readonly NoticeMessage[];
  /** Posted with MessagingStyle. */
  conversation?: boolean;
  ongoing?: boolean;
  groupSummary?: boolean;
  foregroundService?: boolean;
  /** Defaults to true. */
  clearable?: boolean;
  category?: string | null;
  /** Who said the last line, when the app wrote it into the body and it differs from the conversation name. */
  sender?: string | null;
  /** Group chat (true) or one-to-one (false); null when unknown or not a chat. */
  group?: boolean | null;
  /** The conversation name the system gave a MessagingStyle notification. */
  conversationTitle?: string | null;
  /** The title is the latest speaker, not the conversation's name: it must not identify a contact. */
  titleIsSpeaker?: boolean;
  /** The system says this notification is silent. Unknown reads as audible. */
  silent?: boolean;
}

/** A notification the phone pushes through `/api/phones/self/events` — `NoticeRecord` as the wire carries it. */
export const phoneNotice = z.object({
  kind: z.literal("notice"),
  key: z.string().min(1).max(300),
  packageName: z.string().min(1).max(200),
  postedAtMs: z.number().int().nonnegative(),
  title: z.string().max(2_000),
  text: z.string().max(8_000),
  category: z.string().max(80).nullish(),
  ongoing: z.boolean().optional(),
  groupSummary: z.boolean().optional(),
  foregroundService: z.boolean().optional(),
  clearable: z.boolean().optional(),
  conversation: z.boolean().optional(),
  silent: z.boolean().optional(),
  sender: z.string().max(300).nullish(),
  group: z.boolean().nullish(),
  conversationTitle: z.string().max(300).nullish(),
  titleIsSpeaker: z.boolean().optional(),
  messages: z.array(z.object({
    sender: z.string().max(300).nullable(),
    text: z.string().max(2_000),
    atMs: z.number().int(),
  }).strict()).max(30).optional(),
}).strict();

/** The pushed event read back as the record the filters and the inbox hold. */
export function noticeRecordOf(event: z.infer<typeof phoneNotice>): NoticeRecord {
  const { kind: _kind, ...record } = event;
  return record;
}

/**
 * The shade as the phone last read it: every active notification key across the person's ticked packages. The inbox
 * reconciles to it — a record whose key is not here was dismissed, withdrawn or posted while the listener was unbound.
 */
export const phoneNoticeShade = z.object({
  kind: z.literal("notice-shade"),
  keys: z.array(z.string().min(1).max(300)).max(500),
}).strict();

/** One text a notification key showed, oldest first in the inbox's per-key history. */
export interface NoticeLine {
  title: string;
  text: string;
  atMs: number;
}

/** The line a person or a model should see: a group message carries who said it, everything else is the body. */
export function noticeSaid(record: Pick<NoticeRecord, "sender" | "text">): string {
  const sender = record.sender?.trim();
  return sender ? `${sender}: ${record.text}` : record.text;
}

/** Why a notification was kept or dropped. Values are Mika's NoticeDecision, plus `no-access` for the phone-side grant. */
export type NoticeDecision =
  | "keep"
  | "not-whitelisted"
  | "self-package"
  | "app-blocked"
  | "ongoing"
  | "group-summary"
  | "foreground-service"
  | "not-clearable"
  | "category"
  | "blank"
  | "authentication-secret"
  | "no-access";

/**
 * What the caller knows about the person's choices. `listenerGranted` is the system permission Mika reads from the
 * listener; false is a refusal to answer, not an empty notification shade.
 */
export interface NoticePolicy {
  /** Packages the person ticked. Nothing outside this set is read at all. */
  allow: ReadonlySet<string>;
  /** Packages switched off under app access. */
  blocked?: ReadonlySet<string>;
  /** This app's own package names, including preview suffixes. */
  selfPackages?: readonly string[];
  listenerGranted?: boolean;
}

/** This app's own packages; a notification from any suffix of these is never learned. The earlier install ids stay, so a
 * phone that has not updated yet is still recognized. */
export const SELF_PACKAGE_PREFIXES: readonly string[] = Object.freeze(["com.lunabot.companion", "com.dexbot.companion", "com.lunabot.companion"]);

/** Notification categories that are progress, media transport, services, calls, alarms, navigation or timers. */
export const DROPPED_NOTICE_CATEGORIES: ReadonlySet<string> = new Set([
  "progress",
  "transport",
  "service",
  "call",
  "alarm",
  "navigation",
  "stopwatch",
]);

/**
 * The package gate, before any text is read. The whitelist is checked first so a package the person never ticked is
 * not even looked at; then this app's own notifications; then app access.
 */
export function shouldLearnPackage(packageName: string, policy: NoticePolicy): NoticeDecision {
  if (!policy.allow.has(packageName)) return "not-whitelisted";
  if (isSelfPackage(packageName, policy.selfPackages ?? SELF_PACKAGE_PREFIXES)) return "self-package";
  if (policy.blocked?.has(packageName) === true) return "app-blocked";
  return "keep";
}

/** Whether [packageName] is this app under any install suffix (`.dev`, `.preview`, …). */
export function isSelfPackage(packageName: string, prefixes: readonly string[] = SELF_PACKAGE_PREFIXES): boolean {
  return prefixes.some((prefix) => packageName.startsWith(prefix));
}

/**
 * The whole filter: the package gate, then authentication secrets, then notification shapes, then blank content.
 * [record] is expected to be sanitized first (Mika runs `sanitize` before `decide`), but the blank check cleans again
 * so a title made only of control characters still reads as empty.
 */
export function shouldLearn(record: NoticeRecord, policy: NoticePolicy): NoticeDecision {
  if (policy.listenerGranted === false) return "no-access";
  const gate = shouldLearnPackage(record.packageName, policy);
  if (gate !== "keep") return gate;
  const messages = record.messages ?? [];
  const full = [record.title, record.text, messages.map((message) => message.text).join(" ")].join(" ");
  if (holdsSensitiveText(full)) return "authentication-secret";
  if (record.ongoing === true) return "ongoing";
  if (record.groupSummary === true) return "group-summary";
  if (record.foregroundService === true) return "foreground-service";
  if (record.clearable === false) return "not-clearable";
  if (record.category != null && DROPPED_NOTICE_CATEGORIES.has(record.category)) return "category";
  if (cleanNoticeText(record.title, NOTICE_TUNING.FILTER_TITLE_MAX) === "" && cleanNoticeText(record.text, NOTICE_TUNING.FILTER_TEXT_MAX) === "") return "blank";
  return "keep";
}

const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;
// Invisible format characters: soft hyphen, Mongolian vowel separator, word joiner through invisible operators. U+200C
// and U+200D are kept: emoji and some scripts need them.
const INVISIBLE = /[\u00AD\u180E\u2060-\u2064]/gu;
// \p{Z} covers the various spaces and line/paragraph separators; zero-width space and BOM are added.
const SPACES = /[\s\p{Z}\u200B\uFEFF]+/gu;

/**
 * One line of third-party text: ISO control characters become spaces, bidi controls and invisible format characters are
 * removed, runs of whitespace collapse to one space, the ends are trimmed, and the result is cut to [max] UTF-16 units
 * without splitting a surrogate pair.
 */
export function cleanNoticeText(text: string, max: number): string {
  let withoutControls = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    withoutControls += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  const collapsed = withoutControls.replace(BIDI, "").replace(INVISIBLE, "").replace(SPACES, " ").trim();
  return capText(collapsed, max);
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Clean every text field and keep at most the newest messages, dropping ones that clean to nothing. */
export function sanitizeNotice(record: NoticeRecord): NoticeRecord {  const messages = (record.messages ?? [])
    .map((message) => ({
      sender: message.sender == null ? null : cleanNoticeText(message.sender, NOTICE_TUNING.FILTER_TITLE_MAX) || null,
      text: cleanNoticeText(message.text, NOTICE_TUNING.FILTER_TEXT_MAX),
      atMs: message.atMs,
    }))
    .filter((message) => message.text.length > 0);
  const conversationTitle = record.conversationTitle == null
    ? null
    : cleanNoticeText(record.conversationTitle, NOTICE_TUNING.FILTER_TITLE_MAX) || null;
  return {
    ...record,
    title: cleanNoticeText(record.title, NOTICE_TUNING.FILTER_TITLE_MAX),
    conversationTitle,
    text: cleanNoticeText(record.text, NOTICE_TUNING.FILTER_TEXT_MAX),
    messages: messages.slice(Math.max(0, messages.length - NOTICE_TUNING.FILTER_MESSAGES_MAX)),
  };
}

// ---- Authentication secrets ----
// Notification text is the one place one-time codes and passwords arrive uninvited. Mika drops the whole notification
// before it reaches the inbox, the journal or a model. The checks below are a literal port of SensitiveFilter and
// LearnText.authCode: provider key shapes, Chinese ID numbers, card numbers, password keywords, and "登录码 482913" /
// "Your code is 482913" in the languages Mika covers. It is a lexical net, not a guarantee.

const ID_NUMBER = /(?<![0-9])[1-9][0-9]{16}[0-9Xx](?![0-9A-Za-z])/gu;
const CARD_LIKE = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/gu;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = "10X98765432";

const KEYWORDS = "支付密码|密码|口令|验证码|校验码|动态码|安全码|安全问题|(?<![A-Za-z])(?:password|passcode|passwd|cvv|cvc|verification code|security code|security question|one-time code)(?![A-Za-z])";
// pin and otp are short and common inside ordinary English (pinned, hotpot), so they count only before digits.
const DIGIT_KEYWORDS = "(?<![A-Za-z])(?:pin|otp)(?![A-Za-z])";
const KEYWORD_GAP = "[\\s:：=,，是为叫]{0,4}(?:(?:is|was|are)\\s+)?";
const OWNER = "\\s*(?:就是|是|为)(?:我的|我|用户的)?\\s*";
const KEYWORD_RULES: readonly RegExp[] = [
  new RegExp(`(?:${KEYWORDS})${KEYWORD_GAP}[A-Za-z0-9]{4,}`, "iu"),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z0-9]{4,}${OWNER}(?:${KEYWORDS})`, "iu"),
  new RegExp(`${DIGIT_KEYWORDS}${KEYWORD_GAP}[0-9]{4,}`, "iu"),
  new RegExp(`(?<![A-Za-z0-9])[0-9]{4,}${OWNER}${DIGIT_KEYWORDS}`, "iu"),
];

const CODE = "(?:[a-z]{1,3}-)?\\p{Nd}{4,}|\\p{Nd}{3}[ -]\\p{Nd}{3,4}";
const AUTH_GAP = "[ \\t:：=,，是为為叫(（\\[【「『《“\"]{0,4}(?:(?:is|was|are|es|é)[ \\t]*[：:]?[ \\t]*)?";
// A password-like word may be followed by letters and digits, but the secret must contain a digit: otherwise any word
// after the password word in a Latin-script language would count.
const SECRET = "(?=[a-z0-9]*\\p{Nd})[a-z0-9]{4,}";
const AUTH_WORDS = "登录码|登陆码|登入码|确认码|认证码|授权码|短信码|随机码|注册码|绑定码|核验码|交易码|提现码|"
  + "驗證碼|校驗碼|動態碼|安全碼|登錄碼|登入碼|確認碼|認證碼|授權碼|簡訊碼|隨機碼|註冊碼|綁定碼|"
  + "認証コード|確認コード|認証番号|暗証番号|セキュリティコード|"
  + "인증번호|인증 ?코드|보안 ?코드|확인 ?코드|"
  + "c[oó]digo de (?:verificaci[oó]n|verificação|seguridad|segurança|confirmaci[oó]n|confirmação|acceso|acesso)|"
  + "код (?:подтверждения|проверки|доступа|авторизации|для входа)|проверочный код|"
  + "kode (?:verifikasi|otp|keamanan|konfirmasi|login|masuk)|"
  + "رمز التحقق|رمز التأكيد|رمز الدخول|کد تایید|کد تأیید|کد ورود";
const PASSWORD_WORDS = "密碼|ワンタイムパスワード|パスワード|パスコード|비밀번호|contraseña|senha|пароль|kata sandi|كلمة المرور|رمز عبور";
const AUTH_THEN_CODE = new RegExp(`(?:${AUTH_WORDS})${AUTH_GAP}(?:${CODE})`, "u");
const PASSWORD_THEN_SECRET = new RegExp(`(?:${PASSWORD_WORDS})${AUTH_GAP}${SECRET}`, "u");
const CODE_THEN_AUTH = new RegExp(`(?<!\\p{Nd})\\p{Nd}{4,}[ \\t]*(?:就是|是|为|為)(?:你的|您的|我的)?[ \\t]*(?:${AUTH_WORDS}|${PASSWORD_WORDS})`, "u");
const ENGLISH_CODE = new RegExp(
  `(?<![a-z])codes?(?![a-z])(?:[ \\t]*(?:[：:=]|(?:is|was)(?![a-z])[ \\t]*[：:]?)[ \\t]*(?:${CODE})`
    + `|[ \\t]{1,2}(?:(?:[a-z]{1,3}-)?\\p{Nd}{5,}|\\p{Nd}{3}[ -]\\p{Nd}{3,4}))`,
  "gu",
);
const CODE_IS_YOUR = /(?<!\p{Nd})\p{Nd}{4,} is (?:your|the) (?:[a-z-]+ ){0,3}?code(?![a-z])/gu;
// Words that make "code" mean something other than a credential: zip code, error code, promo code…
const NOT_AUTH = new Set([
  "zip", "postal", "post", "area", "country", "dial", "error", "status", "exit", "return", "response", "http",
  "promo", "promotion", "coupon", "discount", "voucher", "invite", "invitation", "referral",
  "pickup", "collection", "tracking", "booking", "reservation", "order", "product", "item", "model",
  "qr", "bar", "source", "color", "colour", "dress", "course", "class", "room", "gate", "door",
]);

function holdsSensitiveText(text: string): boolean {
  const normalized = text.normalize("NFKC");
  const compact = normalized.replace(/\s+/gu, "");
  if (holdsCredential(normalized)) return true;
  if ([...normalized.matchAll(ID_NUMBER)].some((match) => validIdNumber(match[0]))) return true;
  if ([...normalized.matchAll(CARD_LIKE)].some((match) => luhn(match[0].replace(/\D/gu, "")))) return true;
  if (KEYWORD_RULES.some((rule) => rule.test(normalized) || rule.test(compact))) return true;
  return looksLikeAuthCode(normalized);
}

/** Birth date is a real date and the last digit is ISO 7064 MOD 11-2. */
function validIdNumber(id: string): boolean {
  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return false;
  if (year < 1900) return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) sum += (id.charCodeAt(index) - 48) * ID_WEIGHTS[index]!;
  return ID_CHECK[sum % 11] === id.charAt(17).toUpperCase();
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** "登录码 482913", "482913 是你的登录码", "Your code is 482913" — a credential word adjacent to a code. */
function looksLikeAuthCode(normalized: string): boolean {
  const text = normalized.toLowerCase();
  if (AUTH_THEN_CODE.test(text) || PASSWORD_THEN_SECRET.test(text) || CODE_THEN_AUTH.test(text)) return true;
  const compact = text.replace(/[ \t]+/gu, "");
  if (AUTH_THEN_CODE.test(compact)) return true;
  for (const match of text.matchAll(ENGLISH_CODE)) {
    if (!NOT_AUTH.has(wordBefore(text, match.index))) return true;
  }
  for (const match of text.matchAll(CODE_IS_YOUR)) {
    if (!NOT_AUTH.has(wordBefore(text, match.index + match[0].lastIndexOf("code")))) return true;
  }
  return false;
}

/** The English word immediately before [index], across spaces and hyphens; empty when there is none. */
function wordBefore(text: string, index: number): string {
  let end = index;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "-" || text[end - 1] === "\t")) end -= 1;
  let start = end;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    if (code < 0x61 || code > 0x7a) break;
    start -= 1;
  }
  return text.slice(start, end);
}

// ---- The inbox ----

export interface NoticeSnapshot {
  /** Oldest first; one entry per key, holding that key's newest state. */
  records: NoticeRecord[];
  /** The local day (epoch day) the two counters belong to. */
  day: number;
  /** Notifications that passed the package whitelist today. */
  received: number;
  /** Notifications that passed the filters and dedup and entered the inbox today. */
  kept: number;
  /** Per key, the texts a message-less notification showed, oldest first; the last one is the record's current text. */
  history: Map<string, NoticeLine[]>;
}

export interface NoticeInboxOptions {
  capacity?: number;
  clock?: () => number;
  zone?: () => string;
  historyLimit?: number;
}

/**
 * In memory only, at most [capacity] records, oldest dropped first. An update to the same key replaces its record and
 * moves it to the newest position. Apps such as WeChat repost the same notification for every line with only the body
 * changed and no MessagingStyle message list: for those, a short per-key history keeps the distinct texts seen, so the
 * earlier lines are not overwritten. A notification that carries its own message list needs no history.
 *
 * Two counters are kept per local day: received (past the whitelist) and kept (past filters and dedup). Clearing the
 * inbox does not reset them; only a new local day does.
 */
export class NoticeInbox {
  private readonly capacity: number;
  private readonly clock: () => number;
  private readonly zone: () => string;
  private readonly historyLimit: number;
  private readonly records = new Map<string, NoticeRecord>();
  private readonly history = new Map<string, NoticeLine[]>();
  private day: number;
  private received = 0;
  private kept = 0;

  constructor(options: NoticeInboxOptions = {}) {
    this.capacity = options.capacity ?? NOTICE_TUNING.INBOX_CAPACITY;
    this.clock = options.clock ?? Date.now;
    this.zone = options.zone ?? hostTimeZone;
    this.historyLimit = options.historyLimit ?? NOTICE_TUNING.INBOX_HISTORY;
    this.day = this.today();
  }

  /** A notification that passed the package whitelist arrived, whether or not it is kept later. */
  noteReceived(): void {
    this.rollDay();
    this.received += 1;
  }

  /** Add an already filtered, deduped record. */
  add(record: NoticeRecord): void {
    this.rollDay();
    this.kept += 1;
    // Delete first so the update takes the newest position, as Mika's LinkedHashMap does.
    this.records.delete(record.key);
    this.records.set(record.key, record);
    this.remember(record);
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.dropOrphanHistory();
  }

  /** The person opened or swiped away a notification: its record and history go. */
  remove(key: string): void {
    this.history.delete(key);
    this.records.delete(key);
  }

  /**
   * Reconcile with the shade: [active] is every key currently in it. Records no longer there were handled while the
   * listener was unbound, withdrawn by the app, or timed out. Only ever pass a shade that was read successfully;
   * an unreadable shade is not an empty one. Returns how many records were dropped.
   */
  retainKeys(active: ReadonlySet<string>): number {
    const gone = [...this.records.keys()].filter((key) => !active.has(key));
    if (gone.length === 0) return 0;
    for (const key of gone) {
      this.records.delete(key);
      this.history.delete(key);
    }
    return gone.length;
  }

  /** Drop the records of every package [keep] refuses (an app was unticked). */
  removePackages(keep: (packageName: string) => boolean): void {
    let removed = false;
    for (const [key, record] of this.records) {
      if (keep(record.packageName)) continue;
      this.records.delete(key);
      removed = true;
    }
    if (removed) this.dropOrphanHistory();
  }

  clear(): void {
    this.records.clear();
    this.history.clear();
  }

  snapshot(): NoticeSnapshot {
    this.rollDay();
    return {
      records: [...this.records.values()],
      day: this.day,
      received: this.received,
      kept: this.kept,
      history: new Map([...this.history].map(([key, lines]) => [key, [...lines]])),
    };
  }

  private remember(record: NoticeRecord): void {
    if ((record.messages ?? []).length > 0) {
      this.history.delete(record.key);
      return;
    }
    const before = this.history.get(record.key) ?? [];
    const last = before[before.length - 1];
    const said = noticeSaid(record);
    // A group line carries its speaker in the text, so a changed speaker is a different line even with the same body.
    if (last !== undefined && last.title === record.title && last.text === said) return;
    const lines = [...before, { title: record.title, text: said, atMs: record.postedAtMs }];
    this.history.set(record.key, lines.slice(Math.max(0, lines.length - this.historyLimit)));
  }

  private dropOrphanHistory(): void {
    for (const key of this.history.keys()) {
      if (!this.records.has(key)) this.history.delete(key);
    }
  }

  private today(): number {
    return localEpochDay(this.clock(), this.zone());
  }

  private rollDay(): void {
    const today = this.today();
    if (today === this.day) return;
    this.day = today;
    this.received = 0;
    this.kept = 0;
  }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(zone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(zone, format);
  }
  return format;
}

/** The local date of [atMs] in [zone], as an epoch day, the way Mika compares LocalDate.toEpochDay(). */
export function localEpochDay(atMs: number, zone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = dayFormat(zone).formatToParts(atMs);
  } catch {
    parts = dayFormat("UTC").formatToParts(atMs);
  }
  const part = (type: "year" | "month" | "day"): number => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  return Math.floor(Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000);
}

// ---- Dedup ----

/** What one key was last seen as. [sigs] are fingerprints of the messages in memory; Mika does not persist them. */
interface SeenNotice {
  postedAtMs: number;
  lastMessageAtMs: number;
  sigs: ReadonlySet<string> | null;
}

export interface NoticeDedupStore {
  /** Whether [record] holds anything not seen before; a true answer remembers it. */
  accept(record: NoticeRecord): boolean;
  /** As [accept], plus which messages are new (oldest first); null when nothing is new. */
  admit(record: NoticeRecord): { newMessages: NoticeMessage[] } | null;
  clear(): void;
  size(): number;
}

/**
 * Mika's NoticeDedup, in memory only. A plain notification is new when its key is new or its post time changed. A
 * conversation-style notification is new only when it carries a message not seen before: apps repost the whole list on
 * every line, and may push the oldest entries out or fill in unreliable times. Message times are trusted only within
 * [NOTICE_TUNING.CLOCK_SKEW_MS] of the post time; when a previous content fingerprint exists it decides instead.
 * Least recently used keys beyond [capacity] are forgotten.
 */
export function createNoticeDedup(options: { capacity?: number } = {}): NoticeDedupStore {
  const capacity = options.capacity ?? NOTICE_TUNING.DEDUP_CAPACITY;
  const seen = new Map<string, SeenNotice>();

  const touch = (key: string): SeenNotice | undefined => {
    const value = seen.get(key);
    if (value === undefined) return undefined;
    seen.delete(key);
    seen.set(key, value);
    return value;
  };

  const remember = (key: string, value: SeenNotice): void => {
    seen.delete(key);
    seen.set(key, value);
    while (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  };

  const admit = (record: NoticeRecord): { newMessages: NoticeMessage[] } | null => {
    const before = touch(record.key);
    const messages = record.messages ?? [];
    if (record.conversation !== true || messages.length === 0) {
      const fresh = before === undefined || record.postedAtMs !== before.postedAtMs;
      if (fresh) {
        remember(record.key, {
          postedAtMs: record.postedAtMs,
          lastMessageAtMs: before?.lastMessageAtMs ?? Number.MIN_SAFE_INTEGER,
          // Keep the old fingerprints: this sighting carried no messages, the next one still has something to compare.
          sigs: before?.sigs ?? null,
        });
      }
      return fresh ? { newMessages: [] } : null;
    }

    // A saved watermark later than this post time cannot be real; treat it as absent.
    const watermark = before !== undefined && (trustedNoticeTime(before.lastMessageAtMs, record.postedAtMs) || before.lastMessageAtMs < 1)
      ? before.lastMessageAtMs
      : Number.MIN_SAFE_INTEGER;
    const fingerprints = messages.map(messageFingerprint);
    const known = before?.sigs ?? null;
    let freshMessages: NoticeMessage[];
    if (before === undefined) {
      freshMessages = [...messages];
    } else if (known !== null) {
      // With previous content to compare, an app dropping its oldest entries or filling wrong times cannot fool this.
      freshMessages = messages.filter((_, index) => !known.has(fingerprints[index]!));
    } else {
      // First sighting after a message-less record: only a trusted time newer than the watermark is new.
      freshMessages = messages.filter((message) => trustedNoticeTime(message.atMs, record.postedAtMs) && message.atMs > watermark);
    }
    const newest = messages.reduce<number | null>(
      (max, message) => (trustedNoticeTime(message.atMs, record.postedAtMs) && (max === null || message.atMs > max) ? message.atMs : max),
      null,
    );
    const fresh = before === undefined || freshMessages.length > 0;
    remember(record.key, {
      postedAtMs: before !== undefined && !fresh ? before.postedAtMs : record.postedAtMs,
      lastMessageAtMs: Math.max(newest ?? Number.MIN_SAFE_INTEGER, watermark),
      // Remember this sighting's content even when nothing was new, so the next one has something to compare.
      sigs: new Set(fingerprints),
    });
    return fresh ? { newMessages: freshMessages } : null;
  };

  return {
    accept(record) {
      return admit(record) !== null;
    },
    admit,
    clear() {
      seen.clear();
    },
    size() {
      return seen.size;
    },
  };
}

/** A message time is trusted when it is positive and no later than the post time plus the allowed clock skew. */
export function trustedNoticeTime(atMs: number, postedAtMs: number): boolean {
  return atMs >= 1 && atMs <= postedAtMs + NOTICE_TUNING.CLOCK_SKEW_MS;
}

/** A message's identity (speaker, text, time) as a short SHA-256 prefix; in memory only. */
function messageFingerprint(message: NoticeMessage): string {
  return createHash("sha256").update(`${message.sender ?? ""}\u0000${message.text}\u0000${message.atMs}`, "utf8").digest("hex").slice(0, 16);
}

// ---- Triage planning ----

export type TriageDecision = "ignore" | "remember" | "surface";
export type TriageNote = "no-verdict" | "surface-capped";

/** One notification's judgement. [reason] is the model's text, data only; [note] is a built-in explanation. */
export interface TriageVerdict {
  decision: TriageDecision;
  reason?: string;
  note?: TriageNote | null;
}

/** The judgement of a key at one post time. A mark stops counting once the notification's post time changes. */
export type TriageMark =
  | { kind: "done"; postedAtMs: number; verdict: TriageVerdict }
  | { kind: "failed"; postedAtMs: number };

/** The part of a notification the planner reads. */
export interface TriageCandidate {
  key: string;
  packageName: string;
  postedAtMs: number;
}

/** An app with something to judge: when it first had anything (on the caller's clock), and how many. */
export interface PendingApp {
  firstAtMs: number;
  count: number;
}

export type TriageIdleReason = "locked" | "nothing" | "budget-used-up" | "busy" | "in-flight";

/** What to do now: send one app's batch, wake at a time, or do nothing for a stated reason. */
export type TriagePlan =
  | { kind: "send"; packageName: string }
  | { kind: "wait-until"; atMs: number }
  | { kind: "idle"; why: TriageIdleReason };

export interface TriagePlanInput {
  /** Every notification in the inbox, oldest first (as NoticeInbox.snapshot().records). */
  records: readonly TriageCandidate[];
  /** Results by key. One whose post time differs from the record's no longer counts. */
  marks: ReadonlyMap<string, TriageMark>;
  /** Whether a request is already open. It wins over everything else while the screen is unlocked. */
  inFlight?: boolean;
  /** Cooldown end by key, for keys judged or failed recently. */
  coolingUntilMs?: ReadonlyMap<string, number>;
  /**
   * When each app first had something unjudged, on the caller's clock. An app with no entry starts its gathering
   * window now. Mika records the start in `refresh`; a caller porting that keeps this map. For a notification that has
   * just left a cooldown, pass the later of the cooldown end and the moment its new content was first seen, so an
   * unlock after the cooldown does not wait again.
   */
  firstAtMs?: ReadonlyMap<string, number>;
  unlocked: boolean;
  busy: boolean;
  /** The day's request budget, with Mika's "already used up today" latch already folded in by the caller. */
  budgetLeft: boolean;
  nowMs: number;
  windowMs?: number;
  batchMax?: number;
}

/** Mika's TriagePlanner.decide: pending apps and cooldowns already worked out, no records or marks. */
export interface TriageDecideInput {
  unlocked: boolean;
  busy: boolean;
  budgetLeft: boolean;
  pending: ReadonlyMap<string, PendingApp>;
  nowMs: number;
  windowMs?: number;
  batchMax?: number;
  /** The earliest cooldown end among cooling notifications that have new content; null when there are none. */
  coolingUntilMs?: number | null;
  /** A batch is already open. Only reported as an idle reason; the caller has already excluded its keys. */
  inFlight?: boolean;
}

/**
 * The judgement recorded for this notification's current post time, or null when there is none or it was made for an
 * earlier post time. This is what stops a stale verdict from counting after the app updated the notification.
 */
export function triageMarkFor(record: Pick<TriageCandidate, "key" | "postedAtMs">, marks: ReadonlyMap<string, TriageMark>): TriageMark | null {
  const mark = marks.get(record.key);
  return mark !== undefined && mark.postedAtMs === record.postedAtMs ? mark : null;
}

/** How long a key waits before it may be judged again: surface is fixed, ignore/remember escalate by verdict count. */
export function cooldownMs(decision: TriageDecision, verdicts: number): number {
  return decision === "surface"
    ? NOTICE_TUNING.SURFACE_COOLDOWN_MS
    : escalating(NOTICE_TUNING.TRIAGE_BACKOFF_MS, verdicts);
}

/** How long a key waits after its [failures]-th consecutive failed batch; the last step repeats. */
export function failureHoldMs(failures: number): number {
  return escalating(NOTICE_TUNING.FAILURE_HOLD_MS, failures);
}

function escalating(steps: readonly number[], attempt: number): number {
  const index = Math.min(Math.max(attempt - 1, 0), steps.length - 1);
  return steps[index]!;
}

/**
 * Mika's TriagePlanner.decide, exactly: a pure function of the pending apps, the flags and the clock. It only decides
 * whether a batch may be sent, never what it says.
 *
 * The order is Mika's: an open request wins while unlocked (even over a full batch), then a locked screen (which also
 * stops any timing), then nothing to do, then the budget, then a busy task. A batch goes out for the app that already
 * has [batchMax] waiting, or whose oldest waiting notification has waited [windowMs]; the app that has waited longest
 * goes first. Otherwise the caller waits until the earlier of the next app's window end and the earliest cooldown end.
 */
export function decideTriage(input: TriageDecideInput): TriagePlan {
  const windowMs = input.windowMs ?? NOTICE_TUNING.TRIAGE_WINDOW_MS;
  const batchMax = input.batchMax ?? NOTICE_TUNING.TRIAGE_BATCH_MAX;
  const coolingUntil = input.coolingUntilMs ?? null;

  if (input.unlocked && input.inFlight === true) return { kind: "idle", why: "in-flight" };
  if (!input.unlocked) return { kind: "idle", why: "locked" };
  if (input.pending.size === 0 && coolingUntil === null) return { kind: "idle", why: "nothing" };
  if (!input.budgetLeft) return { kind: "idle", why: "budget-used-up" };
  if (input.busy) return { kind: "idle", why: "busy" };

  let ready: { packageName: string; firstAtMs: number } | null = null;
  for (const [packageName, app] of input.pending) {
    if (app.count < batchMax && input.nowMs - app.firstAtMs < windowMs) continue;
    if (ready === null || app.firstAtMs < ready.firstAtMs) ready = { packageName, firstAtMs: app.firstAtMs };
  }
  if (ready !== null) return { kind: "send", packageName: ready.packageName };

  const wakeAt = [...input.pending.values()].map((app) => app.firstAtMs + windowMs);
  if (coolingUntil !== null) wakeAt.push(coolingUntil);
  return { kind: "wait-until", atMs: Math.min(...wakeAt) };
}

/**
 * The planner as the inbox actually presents it: derive the pending apps and the earliest cooldown end from the
 * records and marks, then [decideTriage]. A notification whose mark was made at an earlier post time is pending
 * again; one judged at its current post time is not; one that was judged and has changed since is cooling, and is not
 * pending until its cooldown passes. While a request is open and the screen is unlocked the answer is InFlight before
 * any count matters, so its keys need no separate exclusion, exactly as in Mika's plan().
 */
export function planTriage(input: TriagePlanInput): TriagePlan {
  const coolingEnd = (record: TriageCandidate): number => input.coolingUntilMs?.get(record.key) ?? Number.MIN_SAFE_INTEGER;
  const unjudged = (record: TriageCandidate): boolean => triageMarkFor(record, input.marks) === null;
  const cooling = (record: TriageCandidate): boolean => unjudged(record) && coolingEnd(record) > input.nowMs;

  const coolingRecords = input.records.filter(cooling);
  const coolingUntil = coolingRecords.length > 0 ? Math.min(...coolingRecords.map(coolingEnd)) : null;

  const pending = new Map<string, PendingApp>();
  for (const record of input.records) {
    if (!unjudged(record) || cooling(record)) continue;
    const app = pending.get(record.packageName);
    if (app !== undefined) {
      app.count += 1;
      continue;
    }
    pending.set(record.packageName, { firstAtMs: input.firstAtMs?.get(record.packageName) ?? input.nowMs, count: 1 });
  }

  return decideTriage({
    unlocked: input.unlocked,
    busy: input.busy,
    budgetLeft: input.budgetLeft,
    pending,
    nowMs: input.nowMs,
    coolingUntilMs: coolingUntil,
    inFlight: input.inFlight === true,
    windowMs: input.windowMs ?? NOTICE_TUNING.TRIAGE_WINDOW_MS,
    batchMax: input.batchMax ?? NOTICE_TUNING.TRIAGE_BATCH_MAX,
  });
}

// ---- Learn level and tuning ----

/** Where a package's confidence sits: Low is judged only, Mid is learned, High may also reach tasks. */
export type SourceTier = "low" | "mid" | "high";

/** How aggressive learning is. Even at the highest level nothing is said or sent without the person asking. */
export type LearnLevel = "conservative" | "balanced" | "aggressive";

export interface LearnLevelConfig {
  /** How many different local days a topic must appear on to be established. */
  readonly topicDays: number;
  /** How many different conversations an app may surface per day. */
  readonly surfaceCap: number;
  /** Which source tiers' learned material may be brought into tasks. */
  readonly intoTasks: readonly SourceTier[];
}

/**
 * The three levels, one switch moving a group of thresholds. Conservative brings nothing into tasks; Balanced only
 * High-tier apps; Aggressive allows a topic after a single day and brings Mid and High into tasks.
 */
export const LEARN_LEVELS = {
  conservative: { topicDays: 2, surfaceCap: 10, intoTasks: [] },
  balanced: { topicDays: 2, surfaceCap: 20, intoTasks: ["high"] },
  aggressive: { topicDays: 1, surfaceCap: 2_147_483_647, intoTasks: ["mid", "high"] },
} as const satisfies Record<LearnLevel, LearnLevelConfig>;

/** The level a stored wire value names; anything unknown reads as Conservative. */
export function learnLevelOf(wire: string | null | undefined): LearnLevel {
  return wire === "balanced" || wire === "aggressive" ? wire : "conservative";
}

/**
 * The part of Mika's ObservedTopic the established rule reads, plus what a caller already has. [days] is the number of
 * distinct local days the topic appeared on; Mika derives it from per-app evidence.
 */
export interface ObservedTopic {
  id: string;
  label: string;
  days: number;
  firstSeenMs?: number;
  lastSeenMs?: number;
  /** How many different apps backed it. */
  apps?: number;
  /** A sensitive inference, only ever collected when the person turned that on. */
  sensitive?: boolean;
}

/** Mika's LearnLevel.established: at this level, has the topic appeared on enough different days? */
export function learnableTopic(level: LearnLevel | LearnLevelConfig, topic: Pick<ObservedTopic, "days">): boolean {
  const topicDays = typeof level === "string" ? LEARN_LEVELS[level].topicDays : level.topicDays;
  return topic.days >= topicDays;
}

/**
 * Every number the learning pipeline uses, in one place. Provisional, as in Mika: run it on a real phone, look at what
 * accumulates, then change them. The inbox and dedup capacities are Mika's class defaults; the rest are LearnTuning's
 * and TriagePlanner's.
 */
export const NOTICE_TUNING = Object.freeze({
  // Collection and sending
  /** Most events kept in memory for learning; the oldest already-learned are dropped first. */
  BUFFER_CAP: 200,
  /** Most notifications in one learning batch, one app, oldest first. */
  BATCH_MAX: 12,
  /** An app with this many unlearned events is due. */
  DUE_COUNT: 12,
  /** Or its oldest unlearned event is this old. Checked only when something happens, never on a timer. */
  DUE_AGE_MS: 30 * 60_000,
  /** Longest one learning request may take. */
  TIMEOUT_MS: 30_000,
  /** After a failed batch, hold this long by consecutive failures; the last step repeats. */
  FAILURE_HOLD_MS: Object.freeze([2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const),

  // The inbox and dedup
  /** Most notification records kept in the inbox. */
  INBOX_CAPACITY: 200,
  /** Most earlier texts kept per notification key. */
  INBOX_HISTORY: 10,
  /** Most keys the dedup remembers; least recently used are forgotten. */
  DEDUP_CAPACITY: 500,
  /** How much later than a notification's post time an app-filled message time may be. */
  CLOCK_SKEW_MS: 2 * 60_000,
  /** Longest title and text kept from one notification. */
  FILTER_TITLE_MAX: 200,
  FILTER_TEXT_MAX: 2_000,
  /** Most messages kept from one conversation-style notification. */
  FILTER_MESSAGES_MAX: 20,

  // Learning
  /** Title/text caps on what a learn request carries — tighter than the filter's keep caps. */
  LEARN_TITLE_MAX: 120,
  LEARN_TEXT_MAX: 200,
  /** Same key, same text, this far apart is a repost, not a new occurrence — about half a day. */
  REPEAT_WINDOW_MS: 12 * 3_600_000,
  /** Most this-time-new messages one conversation notice contributes to a learn line. */
  NEW_LINES_MAX: 5,
  /** Most existing topics one learn request offers the model to cite. */
  LEARN_EXISTING_MAX: 30,
  /** Most signals one learn reply may carry. */
  LEARN_SIGNALS_MAX: 8,
  /** Longest a new topic's label may be. */
  LEARN_LABEL_MAX: 24,
  /** A digit run this long in a label fails it — order numbers, phones, codes. */
  LEARN_DIGIT_RUN_MAX: 5,
  // The topic pool
  /** Most distinct days kept per app on one topic, most recent kept. */
  TOPIC_DAYS_PER_APP: 60,
  /** Most apps' evidence one topic carries, most recently seen kept. */
  TOPIC_APPS_PER_TOPIC: 20,
  /** Forgetting scale: retention = exp(-Δt / (TOPIC_STABILITY_DAYS × (1 + strength))). */
  TOPIC_STABILITY_DAYS: 7,
  /** Below this retention a topic is forgotten at the next maintain pass. */
  TOPIC_FORGET_BELOW: 0.1,
  /** Most topics the pool keeps, weakest first out. */
  TOPIC_POOL_CAP: 300,

  // Triage
  /** Most notifications one triage request carries. */
  TRIAGE_BATCH_MAX: 8,
  /** How long an app may gather a triage batch. */
  TRIAGE_WINDOW_MS: 20_000,
  /** Most different conversations an app may surface per day at the default level. */
  SURFACE_CAP_PER_APP: 10,
  /** Cooldown after a notification was judged worth surfacing: the newest text is already on screen. */
  SURFACE_COOLDOWN_MS: 30 * 60_000,
  /** Cooldown after ignore/remember, by how many times judged since the person last handled the notification. */
  TRIAGE_BACKOFF_MS: Object.freeze([2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const),
});

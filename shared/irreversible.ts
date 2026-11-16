// Before a phone-screen step that cannot be undone, the control's own words decide what it is: a closed word list for
// pay, order, delete and send, with order statuses and payment-method names excluded. A person's approval is a
// one-shot grant bound to the app, kind, target, text and amount they approved. Adapted from Mika's
// IrreversibleDetector, ConfirmationGate and IrrevAction (Apache-2.0).

export const IRREVERSIBLE_ACTIONS = ["pay", "order", "delete", "send"] as const;
export type IrreversibleAction = (typeof IRREVERSIBLE_ACTIONS)[number];

export interface IrreversibleHit {
  action: IrreversibleAction;
  /** The exact text, resource id or signal that matched, for the log and the card. */
  matched: string;
}

/** The parts of one PHONE_UI_OBSERVE element the detector reads. */
export interface ControlElement {
  text?: string | null;
  description?: string | null;
  viewId?: string | null;
  className?: string | null;
  /** Left, top, right, bottom in the phone display's pixels. */
  bounds?: readonly number[] | null;
  clickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  password?: boolean;
}

/** A tap on the element, an enter key acting on it, or a horizontal swipe starting on it. */
export type ControlInteraction = "tap" | "enter" | "swipe";

export interface ControlInput {
  /** Absent only for an enter key whose focus the phone cannot name. */
  element?: ControlElement | null;
  /** A tap when absent. A "swipe" is a horizontal swipe that started on the element. */
  interaction?: ControlInteraction;
  /** The screen's other visible texts: what a generic 确认/确定 is confirming. */
  screenTexts?: readonly string[];
}

/** A word anywhere in a short name, or in one segment of a composed name. */
const STRONG = new Map<string, IrreversibleAction>([
  ["支付", "pay"],
  ["付款", "pay"],
  ["转账", "pay"],
  ["删除", "delete"],
  ["撤回", "delete"],
  ["下单", "order"],
  ["购买", "order"],
  ["结算", "order"],
  ["结账", "order"],
  ["取消订单", "order"],
  ["确认收货", "order"],
  ["退款", "order"],
  ["转发", "send"],
]);

/** A longer whitespace-stripped name is not searched for a strong word; its whitespace-separated segments still are. */
const STRONG_MAX_LEN = 12;

/** 待付款 and 已付款 are statuses, not actions. */
const STATUS_PREFIXES = ["待", "已"];

/** 付款成功, 购买记录, 付款方式, 充值中心 and 收款码 are statuses or entries, not actions. */
const STATUS_SUFFIXES = ["成功", "记录", "售后", "明细", "方式", "列表", "中心", "入口", "码"];

/** Payment-method names and settings are not payment actions; removed before the strong match. */
const EXCLUDED = ["支付宝", "支付方式", "支付设置"];

/** Payment-method descriptions on a product page are not a payment action. */
const PAYMENT_ADS = /支持[^\s，,。]{0,8}?(?:付款|支付)|货到付款|先用后付|花呗|分期|付款方式说明/g;

/**
 * Traditional characters folded before matching, as Mika's Hant does, so a 刪除 button on a Taiwanese phone reads as
 * 删除. Only characters that appear in the lists in this file are here; a new list entry may need a new pair.
 */
const FOLD: Readonly<Record<string, string>> = {
  轉: "转", 賬: "账", 帳: "账", 刪: "删", 單: "单", 購: "购", 買: "买", 結: "结", 訂: "订", 認: "认",
  貨: "货", 發: "发", 傳: "传", 佈: "布", 記: "记", 錄: "录", 後: "后", 細: "细", 碼: "码", 寶: "宝",
  設: "设", 唄: "呗", 說: "说", 計: "计", 實: "实", 應: "应", 總: "总", 銀: "银", 尋: "寻", 確: "确",
  優: "优", 減: "减", 運: "运", 紅: "红",
};

/**
 * Deliberate divergence from Mika: its English table matches any label that starts with the word, so "Send message
 * to Alice" counts. Phones here are often in English, so the same four kinds get a short table, but only a whole
 * label that equals an entry counts. Exact equality is also what keeps statuses out, since "Payment history",
 * "Purchase history" and "Sent" never equal an entry.
 */
const ENGLISH = new Map<string, IrreversibleAction>([
  ["pay", "pay"],
  ["pay now", "pay"],
  ["payment", "pay"],
  ["confirm payment", "pay"],
  ["buy", "order"],
  ["buy now", "order"],
  ["purchase", "order"],
  ["place order", "order"],
  ["checkout", "order"],
  ["confirm order", "order"],
  ["delete", "delete"],
  ["remove", "delete"],
  ["delete chat", "delete"],
  ["delete conversation", "delete"],
  ["delete account", "delete"],
  ["send", "send"],
  ["send message", "send"],
  ["post", "send"],
  ["publish", "send"],
  ["reply", "send"],
  ["forward", "send"],
]);

/** Resource-id words that name a write, after the last / and split on _ - . and camel case. */
const VIEW_ID_WORDS = new Map<string, IrreversibleAction>([
  ["send", "send"],
  ["reply", "send"],
  ["pay", "pay"],
  ["delete", "delete"],
  ["remove", "delete"],
  ["checkout", "order"],
]);

const SEARCH_WORDS = ["search", "搜索", "搜寻"];

/** Send buttons named 发送, 发布 and so on, equal to the word or with only a few more characters (发送(1)). */
const SEND_PREFIX_WORDS = ["发送", "传送", "发布", "发表"];
const SEND_PREFIX_SLACK = 4;

/** A generic confirm counts only when the rest of the screen names an irreversible action or a payable amount. */
const GENERIC_CONFIRMS = new Set(["确认", "确定", "ok", "完成", "confirm"]);

const TOTAL_LABELS = ["合计", "实付", "应付", "总计"];
const PAY_SHEET_WORDS = ["支付方式", "付款方式", "支付宝", "银行卡", "收银台", "免密"];
const AMOUNT = /[¥￥$＄]\s*\d|\d+(?:\.\d+)?\s*元/;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}

function fold(text: string): string {
  return text.replace(/[\u4e00-\u9fff]/gu, (char) => FOLD[char] ?? char);
}

function actionAt(text: string, word: string, at: number): boolean {
  if (at > 0 && STATUS_PREFIXES.includes(text[at - 1]!)) return false;
  const rest = text.slice(at + word.length).replace(/^[^\p{L}\p{N}]+/u, "");
  return !STATUS_SUFFIXES.some((suffix) => rest.startsWith(suffix));
}

function strong(label: string): IrreversibleAction | null {
  const folded = fold(label);
  for (const part of [folded, ...folded.split(/\s+/)]) {
    let text = stripWhitespace(part).replace(PAYMENT_ADS, "");
    for (const excluded of EXCLUDED) text = text.split(excluded).join("");
    if (!text || text.length > STRONG_MAX_LEN) continue;
    for (const [word, action] of STRONG) {
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
        if (actionAt(text, word, at)) return action;
      }
    }
  }
  return null;
}

function english(label: string): IrreversibleAction | null {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]+$/u, "");
  const action = ENGLISH.get(normalized);
  if (!action) return null;
  // Whole-label equality already keeps "Payment history" and "Sent" out; this applies the Chinese status affixes
  // too, so a future entry such as "paid" cannot match a 已… or …记录 label.
  const folded = stripWhitespace(fold(label));
  if (STATUS_PREFIXES.some((prefix) => folded.startsWith(prefix))) return null;
  if (STATUS_SUFFIXES.some((suffix) => folded.endsWith(suffix))) return null;
  return action;
}

/**
 * Mika's contextAction for a dialog's or bottom sheet's generic 确认/确定: a payment word on the screen wins, then the
 * first non-order action (a delete confirmation), then an amount with payment-sheet wording, then an order word or a
 * bare amount. Rows and scrolling areas cannot be told apart from plain texts, so every amount on the screen counts.
 */
function contextAction(screenTexts: readonly string[]): IrreversibleAction | null {
  const found = screenTexts.map((text) => strong(text)).filter((action): action is IrreversibleAction => !!action);
  if (found.includes("pay")) return "pay";
  const other = found.find((action) => action !== "order");
  if (other) return other;
  const texts = screenTexts.map(fold);
  const amount = texts.some((text) => TOTAL_LABELS.some((word) => text.includes(word)) || AMOUNT.test(text));
  if (amount && texts.some((text) => PAY_SHEET_WORDS.some((word) => text.includes(word)))) return "pay";
  return found.includes("order") || amount ? "order" : null;
}

function genericConfirm(label: string, screenTexts: readonly string[] | undefined): IrreversibleAction | null {
  if (!screenTexts?.length) return null;
  const normalized = stripWhitespace(fold(label)).toLowerCase().replace(/[^\p{L}\p{N}]+$/u, "");
  if (!GENERIC_CONFIRMS.has(normalized)) return null;
  return contextAction(screenTexts);
}

/** Equal to a send word, or starting with it and at most SEND_PREFIX_SLACK characters longer (发送(1)). */
function prefixWord(label: string): IrreversibleAction | null {
  const text = stripWhitespace(fold(label)).toLowerCase();
  const matches = SEND_PREFIX_WORDS.some((word) => text.startsWith(word) && text.length <= word.length + SEND_PREFIX_SLACK);
  return matches ? "send" : null;
}

function matchText(raw: string, screenTexts: readonly string[] | undefined): IrreversibleHit | null {
  const text = raw.trim();
  if (!text) return null;
  const action = strong(text) ?? prefixWord(text) ?? english(text) ?? genericConfirm(text, screenTexts);
  return action ? { action, matched: text } : null;
}

function viewIdAction(viewId: string): IrreversibleAction | null {
  const words = viewId
    .slice(viewId.lastIndexOf("/") + 1)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/);
  for (const word of words) {
    const action = VIEW_ID_WORDS.get(word);
    if (action) return action;
  }
  return null;
}

function matchElement(element: ControlElement, screenTexts: readonly string[] | undefined): IrreversibleHit | null {
  for (const raw of [element.text, element.description]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const hit = matchText(raw, screenTexts);
    if (hit) return hit;
  }
  if (element.viewId) {
    const action = viewIdAction(element.viewId);
    if (action) return { action, matched: element.viewId };
  }
  return null;
}

function elementLabel(element: ControlElement): string {
  return (element.text ?? "").trim() || (element.description ?? "").trim() || element.viewId || "unknown";
}

/**
 * Our element model has no placeholder separate from the typed text, so only the resource id, class and content
 * description can prove a field is a search box; a field whose text merely says 搜索 is not treated as one.
 */
function isSearchField(element: ControlElement): boolean {
  if ((element.viewId ?? "").toLowerCase().includes("search")) return true;
  if ((element.className ?? "").toLowerCase().includes("searchview")) return true;
  const hint = fold(element.description ?? "").toLowerCase();
  return SEARCH_WORDS.some((word) => hint.includes(word));
}

/** A row is clickable, does not scroll, and is wider than it is tall. */
function isWideRow(element: ControlElement): boolean {
  const bounds = element.bounds;
  if (!bounds || bounds.length !== 4) return false;
  return bounds[2]! - bounds[0]! > bounds[3]! - bounds[1]!;
}

/**
 * What a tap, an enter key or a row swipe on this element would do, or null when it is reversible.
 *
 * Not ported, because they classify web forms, payment panels and job listings the phone tools here do not drive:
 * Mika's SUBMIT_WORDS, contact/application tables, booking words, EXACT_PAY (收银台, 充值, 提现, 打赏, 缴费),
 * RED_PACKET, PUNCT_WORDS (评论, 回复: an entry or a count), the financial-job exemption, key-combo and
 * drag/select handling, and its payment-page amount rules. PREFIX_WORDS is ported only for send (发送, 传送, 发布,
 * 发表): its delete half (清空, 移除, 注销, 退出群聊) needs Mika's editsField guard, which keeps the 清空 button of a
 * search box from reading as a delete. Our flat element list has no field-to-button containment, so those words
 * would block clearing a search box.
 *
 * A PHONE_UI_TAP_AT by coordinate has no element here, so it returns null; the caller has to resolve the element
 * under the point first. Mika also falls back to the model's own target/seen words, which this input does not take.
 *
 * Signals ported: an enter key on a focused field that is not a search box (send), an enter key that activates a
 * send button, and a horizontal swipe starting on a wide non-scrolling row (delete). Not ported: a confirm key as a
 * signal of its own (PHONE_UI_KEY has no confirm key; 确认/确定 buttons are handled through screenTexts above) and
 * the del key (Mika treats it as delete only when no focus is known; on a phone it clears a field, which is typing).
 */
export function classifyControl(input: ControlInput): IrreversibleHit | null {
  const element = input.element ?? null;
  const interaction = input.interaction ?? "tap";
  if (interaction === "enter") {
    // Mika checks whether every field on screen is a search box when no focus is known. The phone names no fields
    // here, so an enter with unknown focus is a send.
    if (!element) return { action: "send", matched: "enter" };
    if (element.editable || element.password) {
      return isSearchField(element) ? null : { action: "send", matched: `enter:${elementLabel(element)}` };
    }
    return matchElement(element, input.screenTexts);
  }
  if (!element) return null;
  if (interaction === "swipe") {
    // Mika also needs the screen width (a 600/999-wide row) and a carousel check. Observe gives pixel bounds but no
    // display size, so a clickable, non-scrolling, wider-than-tall row stands for a list row.
    if (!element.clickable || element.scrollable || !isWideRow(element)) return null;
    return { action: "delete", matched: `swipe:${elementLabel(element)}` };
  }
  // Tapping a field edits it; what it holds is a label or typed text, not an action.
  if (element.editable || element.password) return null;
  return matchElement(element, input.screenTexts);
}

/** What the person approved: fields are already trimmed, and [app] is the Android package name. */
export interface ConfirmationRequest {
  action: IrreversibleAction;
  /** The object acted on; it must be visible on the screen when the grant is used. */
  target: string;
  /** The exact text to send; empty for every other kind. */
  content: string;
  /** The amount the person saw, as text; null when the action has none. */
  amount: string | null;
  app: string;
}

export type DeclareResult = "pending" | "mismatch" | "declined" | "unsupported";

export type Permit =
  | { result: "allowed" }
  | { result: "no-grant" }
  | { result: "mismatch"; reason: string };

/** Typing is part of the approved step; any other write voids the grant. */
export type WriteKind = "typing" | "other";

/** One element of the screen as it is now, as far as the gate reads it. */
export interface ScreenElement {
  text?: string | null;
  description?: string | null;
  editable?: boolean;
  scrollable?: boolean;
  bounds?: readonly number[] | null;
}

export interface ScreenView {
  /** The Android package in front; null when the phone could not tell. */
  packageName: string | null;
  elements: readonly ScreenElement[];
  /** The display height in the same pixels as bounds. With it, a send target must sit in the top 15%. */
  height?: number;
}

/** A grant older than this many steps is void. */
export const MAX_STEPS = 3;

const MATCH_CHARS = 20;
const TITLE_SHARE = 0.15;
const CURRENCY = /[¥￥$＄]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*元/g;
const THOUSANDS = /(?<=\d),(?=\d{3}(?!\d))/g;
const DISCOUNTS = ["优惠", "减", "抵扣", "运费", "券", "红包", "已省"];
const DISCOUNT_WINDOW = 4;

function norm(text: string): string {
  return stripWhitespace(text).toLowerCase();
}

function elementText(element: ScreenElement): string {
  const text = element.text ?? "";
  return text.trim() ? text : element.description ?? "";
}

function top(element: ScreenElement): number {
  const bounds = element.bounds;
  return bounds && bounds.length === 4 ? bounds[1]! : 0;
}

function centerY(element: ScreenElement): number {
  const bounds = element.bounds;
  return bounds && bounds.length === 4 ? (bounds[1]! + bounds[3]!) / 2 : 0;
}

function inside(child: ScreenElement, parent: ScreenElement): boolean {
  const a = child.bounds;
  const b = parent.bounds;
  return (
    !!a && !!b && a.length === 4 && b.length === 4 &&
    a[0]! >= b[0]! && a[1]! >= b[1]! && a[2]! <= b[2]! && a[3]! <= b[3]!
  );
}

/**
 * One row's text: the element plus the elements to its right whose vertical centres fall inside each other's
 * bounds, so 实付 | ¥ | 39.90 reads as one amount.
 */
function rowText(start: ScreenElement, elements: readonly ScreenElement[]): string {
  const bounds = start.bounds;
  if (!bounds || bounds.length !== 4) return elementText(start);
  const startCenter = (bounds[1]! + bounds[3]!) / 2;
  const row = elements
    .filter((element) => {
      const other = element.bounds;
      if (element === start || !other || other.length !== 4) return false;
      return (
        other[0]! >= bounds[0]! &&
        centerY(element) >= bounds[1]! && centerY(element) <= bounds[3]! &&
        startCenter >= other[1]! && startCenter <= other[3]!
      );
    })
    .sort((a, b) => (a.bounds?.[0] ?? 0) - (b.bounds?.[0] ?? 0));
  return elementText(start) + row.map((element) => stripWhitespace(elementText(element))).join("");
}

/** Amounts with a currency mark or 元; a number right after a discount word or a minus sign is not a total. */
function amounts(text: string): number[] {
  const plain = text.replace(THOUSANDS, "");
  const found: number[] = [];
  for (const match of plain.matchAll(CURRENCY)) {
    const before = plain.slice(Math.max(0, (match.index ?? 0) - DISCOUNT_WINDOW), match.index ?? 0);
    if (DISCOUNTS.some((word) => before.includes(word))) continue;
    if (before.trimEnd().endsWith("-")) continue;
    const value = Number(match[1] || match[2]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

function totalOf(label: ScreenElement, shown: readonly ScreenElement[]): number | null {
  const after = (text: string): number | null => {
    for (const word of TOTAL_LABELS) {
      const at = fold(text).indexOf(word);
      if (at < 0) continue;
      const value = amounts(fold(text).slice(at + word.length))[0];
      if (value !== undefined) return value;
    }
    return null;
  };
  return after(elementText(label)) ?? after(rowText(label, shown));
}

/** An amount plus a total label or payment-sheet wording; an ordinary page's price or range is not payable. */
function hasPayableAmount(screen: ScreenView): boolean {
  const shown = screen.elements.filter((element) => !element.editable);
  if (!shown.some((element) => AMOUNT.test(fold(rowText(element, shown))))) return false;
  return shown.some((element) => {
    const text = fold(elementText(element));
    return TOTAL_LABELS.some((word) => text.includes(word)) || PAY_SHEET_WORDS.some((word) => text.includes(word));
  });
}

/**
 * The declared amount must equal the screen's total, not merely appear in it: every total outside a scrolling area
 * must match; with none outside, the total nearest the button does. Without a total label, the largest amount
 * outside a scrolling area must match. A request without a number never matches.
 */
function amountShown(amount: string | null, screen: ScreenView, button: string): boolean {
  const declaredText = amount?.replace(THOUSANDS, "").match(/\d+(?:\.\d+)?/)?.[0];
  if (declaredText === undefined) return false;
  const declared = Number(declaredText);
  if (!Number.isFinite(declared)) return false;
  const shown = screen.elements.filter((element) => !element.editable);
  const scrollables = screen.elements.filter((element) => element.scrollable);
  const outside = (element: ScreenElement) => !scrollables.some((scrollable) => inside(element, scrollable));
  const labels = shown.filter((element) => TOTAL_LABELS.some((word) => fold(elementText(element)).includes(word)));
  if (labels.length) {
    const totals = labels.map((element) => ({ element, value: totalOf(element, shown) }));
    if (totals.some((total) => total.value === null)) return false;
    const outer = totals.filter((total) => outside(total.element));
    if (outer.length) return outer.every((total) => total.value === declared);
    const buttonElement = shown.find((element) => elementText(element).trim() === button.trim());
    const nearest = [...totals].sort((a, b) => {
      const da = buttonElement ? Math.abs(centerY(a.element) - centerY(buttonElement)) : -top(a.element);
      const db = buttonElement ? Math.abs(centerY(b.element) - centerY(buttonElement)) : -top(b.element);
      return da - db;
    })[0];
    return nearest?.value === declared;
  }
  const candidates = shown.filter(outside).flatMap((element) => amounts(elementText(element)));
  if (!candidates.length) return false;
  return Math.max(...candidates) === declared;
}

/**
 * The target must be non-editable text of at least two characters. For a send, Mika also requires it in the top
 * title band, where the chat's recipient is; with a display height that band is the top 15%. Observe carries no
 * display size, so without a height the target is accepted anywhere on the screen, which is weaker than Mika.
 */
function targetShown(request: ConfirmationRequest, screen: ScreenView): boolean {
  const target = norm(request.target).slice(0, MATCH_CHARS);
  if (target.length < 2) return false;
  return screen.elements.some((element) => {
    if (element.editable || !norm(elementText(element)).includes(target)) return false;
    if (request.action !== "send") return true;
    const bounds = element.bounds;
    if (!bounds || bounds.length !== 4) return false;
    if (typeof screen.height !== "number" || !(screen.height > 0)) return true;
    return bounds[1]! <= screen.height * TITLE_SHARE;
  });
}

/** The text to send must equal what was approved; a truncated request (ending …) compares as a prefix. */
function contentMatches(content: string, screen: ScreenView, typing: string | undefined): boolean {
  const capped = content.endsWith("…");
  const declared = norm(content.replace(/…$/, ""));
  const same = (text: string) => (capped ? norm(text).startsWith(declared) : norm(text) === declared);
  if (typing !== undefined) return same(typing);
  return screen.elements.some((element) => element.editable && typeof element.text === "string" && same(element.text));
}

function amountBinds(hit: IrreversibleHit, screen: ScreenView): boolean {
  if (hit.action === "order" || hit.action === "pay") return true;
  if (hit.action === "send") return false;
  return hasPayableAmount(screen);
}

function mismatch(reason: string): Permit {
  return { result: "mismatch", reason };
}

function declineKey(action: IrreversibleAction, app: string): string {
  return `${action}\u0000${app}`;
}

/**
 * The person's approval, kept as a one-shot grant. It permits the next matching irreversible step only: the same
 * app, the same kind, the target visible on the screen, the approved text being typed (send), and the approved
 * amount on the screen (order always; delete only when the screen is a payment). The grant is consumed by the next
 * hit whether or not it matches, and voided by any write other than typing or by MAX_STEPS steps. A refusal is
 * remembered per kind and app for the run. Pure: steps come from the caller, there is no clock.
 */
export class ConfirmGate {
  private pending: ConfirmationRequest | null = null;
  private grant: { request: ConfirmationRequest; step: number } | null = null;
  private readonly declined = new Set<string>();

  declare(request: ConfirmationRequest, foregroundPackage: string | null): DeclareResult {
    if (request.action === "pay") return "unsupported";
    if (this.declined.has(declineKey(request.action, request.app))) return "declined";
    if (!foregroundPackage || foregroundPackage !== request.app) return "mismatch";
    this.pending = request;
    return "pending";
  }

  decide(approved: boolean, step: number): void {
    const request = this.pending;
    this.pending = null;
    if (!request) return;
    if (!approved) {
      this.declined.add(declineKey(request.action, request.app));
      return;
    }
    this.grant = { request, step };
  }

  permits(hit: IrreversibleHit, screen: ScreenView, step: number, typing?: string): Permit {
    const grant = this.grant;
    this.grant = null;
    if (!grant) return { result: "no-grant" };
    const request = grant.request;
    if (hit.action === "pay") return mismatch("payment is never approved here");
    if (step - grant.step > MAX_STEPS) return mismatch(`the approval expired (${MAX_STEPS} steps)`);
    if (hit.action !== request.action) return mismatch(`approved ${request.action} but this step is ${hit.action}`);
    if (!screen.packageName || screen.packageName !== request.app) {
      return mismatch(`approved in ${request.app} but the screen shows ${screen.packageName ?? "unknown"}`);
    }
    if (!targetShown(request, screen)) {
      return mismatch(`the target "${request.target}" is not shown ${request.action === "send" ? "in the title area" : "on the screen"}`);
    }
    if (request.action === "send" && !contentMatches(request.content, screen, typing)) {
      return mismatch("the text to send is not exactly what was approved");
    }
    if (amountBinds(hit, screen) && !amountShown(request.amount, screen, hit.matched)) {
      return mismatch(`the approved amount ${request.amount ?? "(none)"} is not on the screen`);
    }
    return { result: "allowed" };
  }

  /** Mika also keeps a grant through clearing a field (Verb.ClearText); here only typing does, since PHONE_UI_KEY
   * "del" is a separate write the caller can report as "other". */
  noteWrite(kind: WriteKind): void {
    if (kind !== "typing") this.grant = null;
  }

  reset(): void {
    this.pending = null;
    this.grant = null;
    this.declined.clear();
  }
}

// Adapted from Mika's RiskJudge and ClassifiedRisk (Apache-2.0).
//
// Grades one phone step by what it would do, not only by whether it is irreversible: a read, a change to the screen,
// something handed to the world outside it, something that cannot be undone, or a control the word list cannot name.
// It also keeps Mika's insight that an amount on a screen is page content, not a charge, unless the screen shows a
// payment context. This module only grades: it grants nothing, and a payment is still refused by the confirmation gate.
import { isPhoneToolName, isPhoneWrite, phoneToolSends } from "../shared/phone-apps.ts";
import type { IrreversibleHit, ScreenElement, ScreenView } from "../shared/irreversible.ts";

/**
 * The five grades, weakest first. `read` only looks at a screen or moves between them; `change` alters something, on
 * the screen or in the phone's own data; `external` hands something to the world outside the phone; `irreversible`
 * cannot be undone; `unknown` is a step whose nature cannot be told.
 */
export const ACTION_RISK = ["read", "change", "external", "irreversible", "unknown"] as const;
export type ActionRisk = (typeof ACTION_RISK)[number];

/**
 * The phone tools that change what is on the screen, decided from PHONE_TOOL_NAMES:
 *
 *   PHONE_UI_TAP, PHONE_UI_TAP_AT   the tap acts on the control under it
 *   PHONE_UI_TYPE                   typing edits the focused field
 *   PHONE_UI_KEY                    a key acts on the focused field, and enter submits
 *   PHONE_UI_RUN                    an ordered chain of the steps above
 *   PHONE_UI_DO_EACH                the same chain, once per list item
 *
 * Everything else leaves the screen's state alone. PHONE_UI_SCROLL, PHONE_UI_SWIPE, PHONE_UI_BACK and PHONE_UI_LAUNCH
 * only move between screens; PHONE_UI_COLLECT and PHONE_UI_FIND scroll only to read. The rest read, or act off the
 * screen altogether, so this table never decides them.
 */
export const CHANGE_VERBS: ReadonlySet<string> = new Set([
  "PHONE_UI_TAP", "PHONE_UI_TAP_AT", "PHONE_UI_TYPE", "PHONE_UI_KEY", "PHONE_UI_RUN", "PHONE_UI_DO_EACH",
]);

/**
 * Tools that only move around the screen or scroll it to read, whatever the write/read split says: PHONE_UI_COLLECT
 * and PHONE_UI_FIND are writes because they scroll, but they change no content, and PHONE_OPEN_LINK only opens a
 * screen. Mika's ClassifiedRisk reads scrolling, back, launching and opening a link the same way.
 */
const NAVIGATION: ReadonlySet<string> = new Set([
  "PHONE_UI_SCROLL", "PHONE_UI_SWIPE", "PHONE_UI_BACK", "PHONE_UI_LAUNCH", "PHONE_UI_COLLECT", "PHONE_UI_FIND",
  "PHONE_OPEN_LINK",
]);

/** Tools that hand the bot's own content to another app, which then sends it: outward like a send, though the person
 * still presses that app's own send button. */
const SHARING: ReadonlySet<string> = new Set(["PHONE_SHARE_TEXT", "PHONE_FILE_SHARE"]);

/** The bare tool name, accepting the MCP-shaped `mcp__device__PHONE_UI_TAP` a caller may pass. */
function bare(tool: string): string {
  const at = tool.lastIndexOf("__");
  return at >= 0 ? tool.slice(at + 2) : tool;
}

/** Whether this tool changes what is on the screen, rather than only moving between screens or reading them. */
export function changesState(tool: string): boolean {
  return CHANGE_VERBS.has(bare(tool));
}

/**
 * What the word list named. The four kinds are our `IrreversibleHit`; `unknown` is Mika's catch-all (its `other`),
 * for a control the detector could not name.
 */
export type RiskHit = IrreversibleHit | { action: "unknown"; matched: string };

export interface RiskInput {
  /** The tool as the bot called it, plain or MCP-shaped. */
  tool: string;
  /** The call's arguments. Accepted for the caller's convenience; the classifier has already read them into `hit`. */
  args?: Readonly<Record<string, unknown>> | null;
  /** What the word list made of the control, or null when it named nothing. */
  hit?: RiskHit | null;
  /** The screen the step is judged against. Malformed input reads as an empty screen, never a throw. */
  screen?: ScreenView | null;
}

export interface RiskGrade {
  level: ActionRisk;
  /** A short sentence for a log or a card. It never quotes the screen's own text. */
  why: string;
}

/**
 * Grade one step. A hit is stronger evidence than the tool's own nature, so it decides the level whenever it is
 * there; without one the tool does:
 *
 *   a change verb (see CHANGE_VERBS)            change
 *   PHONE_SEND_MESSAGE, PHONE_SEND_WHATSAPP     external, a message leaving the phone
 *   PHONE_SHARE_TEXT, PHONE_FILE_SHARE          external, content handed to another app
 *   a navigation tool, or any other read        read
 *   any other write (events, clipboard, home)   change, off the screen
 *   a name this server does not know            unknown
 *
 * The payment rule is Mika's: pay and order always count as spending money, send never does, and the looser kinds
 * count only when the screen really shows a payment context. Here the level carries that: the catch-all becomes
 * irreversible on such a screen, and a delete says so in its sentence. An amount anywhere else on the page is
 * content, not a charge.
 */
export function assessRisk(input: RiskInput): RiskGrade {
  const hit = input.hit ?? null;
  if (!hit) {
    if (changesState(input.tool)) {
      return { level: "change", why: "This step changes what is on the screen." };
    }
    const name = bare(input.tool);
    if (!isPhoneToolName(name)) {
      return { level: "unknown", why: "The tool is not one this server knows, so its risk cannot be told." };
    }
    if (phoneToolSends(name)) {
      return { level: "external", why: "This step puts a message on its way out of the phone." };
    }
    if (SHARING.has(name)) {
      return { level: "external", why: "This step hands content to another app, which may send it on." };
    }
    if (NAVIGATION.has(name) || !isPhoneWrite(name)) {
      return { level: "read", why: "This step reads, or only moves between screens; it changes nothing." };
    }
    return { level: "change", why: "This step changes the phone's own data rather than the screen." };
  }
  const payable = hasPayableAmount(input.screen);
  switch (hit.action) {
    case "send":
      return { level: "external", why: "This step sends something out of the phone, and the person cannot take it back." };
    case "pay":
      return { level: "irreversible", why: "This step pays, which cannot be undone." };
    case "order":
      return { level: "irreversible", why: "This step places an order, which cannot be undone." };
    case "delete":
      return payable
        ? { level: "irreversible", why: "This step deletes something on a screen that shows a total to pay, and it cannot be undone." }
        : { level: "irreversible", why: "This step deletes something, which cannot be undone." };
    default:
      return payable
        ? { level: "irreversible", why: "The control names no known action, and the screen adds up to a payment, so this step is treated as spending money." }
        : { level: "unknown", why: "The control names no action this gate knows, so its risk cannot be told." };
  }
}

/**
 * Whether this screen shows a payment context: an amount in a row with a total label, an amount in a pay control's
 * own row, or a payment sheet's wording with an amount on it. A price, a salary range, a discount or a delivery note
 * elsewhere on the page is content, not a charge, and a field the person typed into is not the page speaking. This
 * is Mika's `hasPayableAmount`, narrowed so that the amount must sit with the total or the control that takes it.
 */
export function hasPayableAmount(screen: ScreenView | null | undefined): boolean {
  const shown = shownOf(screen);
  for (const element of shown) {
    const label = fold(elementText(element)).toLowerCase();
    if (!hasAmount(rowText(element, shown))) continue;
    if (TOTAL_WORDS.some((word) => label.includes(word))) return true;
    if (PAY_CONTROLS.some((word) => label.includes(word))) return true;
  }
  // A payment sheet's own wording, with an amount somewhere on the same screen.
  if (!shown.some((element) => hasAmount(rowText(element, shown)))) return false;
  return shown.some((element) => PAY_SHEET.some((word) => fold(elementText(element)).toLowerCase().includes(word)));
}

/** 合计 and 总计 are what the page says is due; 实付 and 应付 are what will leave the person's account. */
const TOTAL_WORDS = ["合计", "实付", "应付", "总计"];

/** A control that takes money: an amount in its row is a charge, not a price tag. */
const PAY_CONTROLS = ["支付", "付款", "pay now", "confirm payment", "checkout", "结算"];

/** A payment sheet's wording: with an amount anywhere, the screen is a place to pay. */
const PAY_SHEET = ["支付密码", "输入密码支付", "payment password", "收银台", "付款方式", "支付方式", "银行卡", "免密"];

/** An amount with a currency mark or 元. */
const CURRENCY = /[¥￥$＄]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*元/gu;
const THOUSANDS = /(?<=\d),(?=\d{3}(?!\d))/gu;

/** A number just after one of these, or after a minus sign, is a discount or a fee, not a charge. */
const DISCOUNTS = ["优惠", "减", "抵扣", "运费", "券", "红包", "已省"];
const DISCOUNT_WINDOW = 4;

/** Traditional characters folded before matching, so a Taiwanese phone's 合計 reads as 合计. */
const FOLD: Readonly<Record<string, string>> = {
  計: "计", 應: "应", 總: "总", 實: "实", 銀: "银", 確: "确", 單: "单", 臺: "台",
};

function fold(text: string): string {
  return text.replace(/[\u4e00-\u9fff]/gu, (char) => FOLD[char] ?? char);
}

/** The element's label: its text, or its content description when the text is empty. */
function elementText(element: ScreenElement): string {
  const text = typeof element.text === "string" ? element.text : "";
  if (text.trim()) return text;
  return typeof element.description === "string" ? element.description : "";
}

/** The elements a payment context can be read from: everything shown, and never a field the person typed into. */
function shownOf(screen: ScreenView | null | undefined): readonly ScreenElement[] {
  const elements: unknown = screen?.elements;
  if (!Array.isArray(elements)) return [];
  return elements.filter((element: unknown): element is ScreenElement =>
    typeof element === "object" && element !== null && (element as { editable?: unknown }).editable !== true);
}

/** The four bounds, or null when the phone sent something that is not a box. */
function box(element: ScreenElement): readonly number[] | null {
  const bounds: unknown = element.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  return bounds.every((part: unknown) => typeof part === "number" && Number.isFinite(part)) ? bounds : null;
}

/** One row's text: the element plus the elements beside it, left to right, so 合计 | ¥ | 25 reads as one amount. */
function rowText(start: ScreenElement, shown: readonly ScreenElement[]): string {
  const own = fold(elementText(start));
  const bounds = box(start);
  if (!bounds) return own;
  const centre = (bounds[1]! + bounds[3]!) / 2;
  const beside: Array<{ left: number; text: string }> = [];
  for (const element of shown) {
    if (element === start) continue;
    const other = box(element);
    if (!other) continue;
    const otherCentre = (other[1]! + other[3]!) / 2;
    if (other[0]! < bounds[0]! || otherCentre < bounds[1]! || otherCentre > bounds[3]!) continue;
    if (centre < other[1]! || centre > other[3]!) continue;
    beside.push({ left: other[0]!, text: fold(elementText(element)).replace(/\s+/gu, "") });
  }
  beside.sort((a, b) => a.left - b.left);
  return own + beside.map((entry) => entry.text).join("");
}

/** A currency-marked amount, unless a discount word or a minus sign sits just before it. */
function hasAmount(text: string): boolean {
  const plain = text.replace(THOUSANDS, "");
  for (const match of plain.matchAll(CURRENCY)) {
    const at = match.index ?? 0;
    const before = plain.slice(Math.max(0, at - DISCOUNT_WINDOW), at);
    if (DISCOUNTS.some((word) => before.includes(word))) continue;
    if (before.trimEnd().endsWith("-")) continue;
    return true;
  }
  return false;
}

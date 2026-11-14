// fill_payment's page side: mark a checkout's card fields (autocomplete tokens first, name/id/label
// hints next), then type each value as real input — secrets never travel inside an eval script, so
// they cannot land in engine-call logs. Fields inside cross-origin frames (Stripe/Braintree/Adyen)
// are unreachable: the outcome says so instead of guessing.
export interface CardFillSecrets {
  pan: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  holder?: string;
}

export interface CardFillDeps {
  engine(args: string[]): Promise<Record<string, unknown> | null>;
  insertText(text: string): Promise<void>;
}

export type CardFillOutcome =
  | { ok: true; host: string; href: string; filled: string[]; text: string }
  | { ok: false; reason: "no-browser" | "no-fields" | "protected-frame" | "stopped"; host: string; text: string };

const MARK = "data-omb-card";
const CARD_FIELD_ORDER = ["number", "expiry", "expMonth", "expYear", "cvc", "name"] as const;
type CardField = (typeof CARD_FIELD_ORDER)[number];

/** Marks every usable card field with data-omb-card=<kind> and reports which kinds exist. */
const FIND_FIELDS = `(function () {
  const MARK = ${JSON.stringify(MARK)};
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; };
  const usable = (el) => el instanceof HTMLElement && visible(el) && !el.readOnly;
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase();
  const hint = (el) => [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("data-field"), el.getAttribute("name")].join(" ").toLowerCase();
  const kind = (el) => {
    const ac = tokens(el);
    if (ac.includes("cc-number")) return "number";
    if (ac.includes("cc-exp") && !ac.includes("cc-exp-month") && !ac.includes("cc-exp-year")) return "expiry";
    if (ac.includes("cc-exp-month")) return "expMonth";
    if (ac.includes("cc-exp-year")) return "expYear";
    if (ac.includes("cc-csc")) return "cvc";
    if (ac.includes("cc-name")) return "name";
    const h = hint(el);
    if (/card\\s*(number|no)|cardnumber|卡号/.test(h)) return "number";
    if (/\\bcvv\\b|\\bcvc\\b|\\bcid\\b|security\\s*code|安全码|验证码/.test(h)) return "cvc";
    if (/expir|mm\\s*[/\\\\-]\\s*yy|有效期/.test(h)) return /month|月/.test(h) ? "expMonth" : /year|年/.test(h) ? "expYear" : "expiry";
    if (/card\\s*holder|cardholder|name\\s*on\\s*card|持卡人/.test(h)) return "name";
    return null;
  };
  const found = {};
  for (const el of Array.from(document.querySelectorAll("input, select"))) {
    if (!usable(el)) continue;
    const k = el.tagName === "SELECT"
      ? (/year|年/.test(hint(el)) ? "expYear" : /month|月/.test(hint(el)) ? "expMonth" : null)
      : kind(el);
    if (k && !found[k]) { found[k] = el.tagName; el.setAttribute(MARK, k); }
  }
  const frames = Array.from(document.querySelectorAll("iframe")).filter((f) => /stripe|braintree|adyen|checkout|pay/i.test(f.src || "")).length;
  return { fields: Object.keys(found), tags: found, frames, href: location.href };
})()`;

const FOCUS_FIELD = (field: CardField) => `(function () { const el = document.querySelector("[${MARK}='${field}']"); if (el) el.focus(); return Boolean(el); })()`;
const SET_SELECT = (field: CardField, value: string) => `(function () {
  const el = document.querySelector("select[${MARK}='${field}']");
  if (!el) return false;
  const want = ${JSON.stringify(value)};
  const option = Array.from(el.options).find((o) => o.value === want || o.text === want || o.value.replace(/^0+/, "") === want || o.text.replace(/^0+/, "") === want);
  if (!option) return false;
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

const expYY = (year: number) => String(year % 100).padStart(2, "0");
const expMM = (month: number) => String(month).padStart(2, "0");

const evalScript = async (deps: CardFillDeps, source: string): Promise<unknown> =>
  (await deps.engine(["eval", source]))?.result;

const pageHost = (href: string) => { try { return new URL(href).host; } catch { return ""; } };

export async function fillCard(card: CardFillSecrets, deps: CardFillDeps): Promise<CardFillOutcome> {
  const url = (await deps.engine(["get", "url"]))?.url;
  if (url === undefined) return { ok: false, reason: "no-browser", host: "", text: "The page is gone; the browser is not answering." };
  if (url === null) return { ok: false, reason: "stopped", host: "", text: "The browser stopped while the card fields were being found." };
  const host = pageHost(String(url));
  const found = await evalScript(deps, FIND_FIELDS) as { fields?: string[]; tags?: Record<string, string>; frames?: number; href?: string } | null;
  const fields = (found?.fields ?? []).filter((field): field is CardField => (CARD_FIELD_ORDER as readonly string[]).includes(field));
  if (!fields.length) {
    const framed = (found?.frames ?? 0) > 0;
    return {
      ok: false, reason: framed ? "protected-frame" : "no-fields", host,
      text: framed
        ? `The payment form on ${host} sits inside a protected frame (a Stripe-style widget), which a fill cannot reach. Call request_sign_in so the person completes the payment themselves.`
        : `No card fields are visible on ${host}. Open the checkout page with the card form showing, then call fill_payment again.`,
    };
  }
  const values: Partial<Record<CardField, string>> = {
    number: card.pan,
    cvc: card.cvc,
    name: card.holder,
    expiry: `${expMM(card.expMonth)}/${expYY(card.expYear)}`,
    expMonth: expMM(card.expMonth),
    expYear: expYY(card.expYear),
  };
  const filled: string[] = [];
  for (const field of fields) {
    const value = values[field];
    if (!value) continue;
    if (found?.tags?.[field] === "SELECT") {
      const candidates = field === "expYear" ? [String(card.expYear), expYY(card.expYear)] : [value, String(Number(value))];
      let set = false;
      for (const candidate of candidates) {
        if (await evalScript(deps, SET_SELECT(field, candidate)) === true) { set = true; break; }
      }
      if (set) filled.push(field);
      continue;
    }
    if (await evalScript(deps, FOCUS_FIELD(field)) !== true) continue;
    await deps.insertText(value);
    filled.push(field);
  }
  if (!filled.includes("number")) {
    return { ok: false, reason: "no-fields", host, text: `The card number field on ${host} would not take input. Check the form, or call request_sign_in so the person pays.` };
  }
  const words = filled.map((field) => ({ number: "card number", expiry: "expiry", expMonth: "expiry month", expYear: "expiry year", cvc: "security code", name: "cardholder name" })[field]);
  return {
    ok: true, host, href: String(found?.href ?? url), filled,
    text: `Filled the ${words.join(", ")} on ${host}. Nothing was submitted: check the form and place the order yourself when it is right.`,
  };
}

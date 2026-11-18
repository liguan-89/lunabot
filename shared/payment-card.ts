/** A payment card the person saved for bots to check out with: the wire view never carries a PAN or
 * CVC. The full fields stay server-side (server/payment-cards.ts) and are filled into the page by the
 * server itself, like saved logins. */
import type { LoginBots } from "./logins.ts";

export interface PaymentCardInput {
  /** What the person calls it, e.g. "WildCard US"; falls back to "<brand> ····last4". */
  name?: string;
  pan: string;
  /** "MM/YY" or "MM/YYYY". */
  expiry: string;
  cvc: string;
  holder?: string;
  bots?: LoginBots;
}

/** The card as clients may see it: display fields only, never enough to pay. */
export interface PaymentCardView {
  id: string;
  name: string;
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  holder?: string;
  bots: LoginBots;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type CardBrand = "visa" | "mastercard" | "amex" | "unionpay" | "jcb" | "discover" | "diners" | "card";

export const PAYMENT_NAME_MAX = 80;
export const PAYMENT_HOLDER_MAX = 120;

export function cardBrand(pan: string): CardBrand {
  if (pan.startsWith("4")) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(pan)) return "mastercard";
  if (/^3[47]/.test(pan)) return "amex";
  if (pan.startsWith("62")) return "unionpay";
  if (pan.startsWith("35")) return "jcb";
  if (/^6(?:011|5)/.test(pan)) return "discover";
  if (/^3[0689]/.test(pan)) return "diners";
  return "card";
}

export function parseExpiry(input: string): { month: number; year: number } | null {
  const m = /^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/.exec(input.trim());
  if (!m) return null;
  const month = Number(m[1]);
  let year = Number(m[2]);
  if (m[2]!.length === 2) year += 2000;
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
  return { month, year };
}

/** Luhn check: a mistyped number must never be saved where a checkout depends on it. */
export function panLooksValid(pan: string): boolean {
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let digit = pan.charCodeAt(pan.length - 1 - i) - 48;
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

export type PaymentCardProblem = "pan" | "expiry" | "cvc" | "name" | "holder";

export function normalizePaymentCard(input: PaymentCardInput): { ok: true; value: Omit<PaymentCardView, "id" | "createdAt" | "updatedAt"> & { pan: string; cvc: string } } | { ok: false; problem: PaymentCardProblem } {
  const pan = input.pan.replace(/[\s-]+/g, "");
  if (!panLooksValid(pan)) return { ok: false, problem: "pan" };
  const expiry = parseExpiry(input.expiry);
  if (!expiry) return { ok: false, problem: "expiry" };
  const cvc = input.cvc.trim();
  if (!/^\d{3,4}$/.test(cvc)) return { ok: false, problem: "cvc" };
  const brand = cardBrand(pan);
  const last4 = pan.slice(-4);
  const name = (input.name ?? "").trim().slice(0, PAYMENT_NAME_MAX) || `${brand === "card" ? "Card" : brand[0]!.toUpperCase() + brand.slice(1)} ····${last4}`;
  const holder = (input.holder ?? "").trim().slice(0, PAYMENT_HOLDER_MAX) || undefined;
  return { ok: true, value: { name, brand, last4, expMonth: expiry.month, expYear: expiry.year, holder, bots: input.bots ?? "all", pan, cvc } };
}

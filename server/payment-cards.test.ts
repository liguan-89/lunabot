import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PAYMENT_CARDS_FILE, PaymentCards } from "./payment-cards.ts";

// Obvious fakes only; the PAN is Luhn-valid the way a checkout test card is.
const PAN = "4242424242424242";
const CARD = { name: "Work card", pan: PAN, expiry: "12/30", cvc: "123", holder: "Li Guan" };

function store() {
  return { dir: mkdtempSync(join(tmpdir(), "omb-cards-")), cards: null as PaymentCards | null };
}

describe("payment cards", () => {
  it("saves a card and lists its display view only: no PAN, no CVC anywhere", () => {
    const { dir } = store();
    const cards = new PaymentCards({ dataDir: dir, now: () => 1_000 });
    const added = cards.add(CARD);
    expect(added.ok).toBe(true);
    const [card] = cards.list();
    expect(card).toMatchObject({ name: "Work card", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, holder: "Li Guan", bots: "all" });
    expect(JSON.stringify(card)).not.toContain(PAN);
    expect(JSON.stringify(card)).not.toContain("123");
    expect(readFileSync(join(dir, PAYMENT_CARDS_FILE), "utf8")).not.toContain(PAN);
  });

  it("keeps the PAN out of the file on disk and reads it back through a fresh instance", () => {
    const { dir } = store();
    new PaymentCards({ dataDir: dir }).add(CARD);
    const raw = readFileSync(join(dir, PAYMENT_CARDS_FILE), "utf8");
    expect(raw).not.toContain(PAN);
    expect(raw).not.toContain('"pan"');
    const reopened = new PaymentCards({ dataDir: dir });
    const [card] = reopened.list();
    expect(reopened.secrets(card!.id, "any-bot")).toMatchObject({ pan: PAN, cvc: "123", expMonth: 12, expYear: 2030 });
  });

  it("hands secrets only to a bot the card allows", () => {
    const { dir } = store();
    const cards = new PaymentCards({ dataDir: dir });
    const a = cards.add({ ...CARD, bots: ["b1"] });
    const b = cards.add({ ...CARD, pan: "5555555555554444", expiry: "01/31", cvc: "321", bots: ["b2"] });
    expect(cards.list("b1").map((card) => card.id)).toEqual([(a as { card: { id: string } }).card.id]);
    expect(cards.secrets((a as { card: { id: string } }).card.id, "b2")).toBeNull();
    expect(cards.secrets((b as { card: { id: string } }).card.id, "b2")?.pan).toBe("5555555555554444");
  });

  it("refuses a mistyped number or a bad expiry and never saves it", () => {
    const { dir } = store();
    const cards = new PaymentCards({ dataDir: dir });
    expect(cards.add({ ...CARD, pan: "4242424242424241" })).toMatchObject({ ok: false, problem: "pan" });
    expect(cards.add({ ...CARD, expiry: "13/30" })).toMatchObject({ ok: false, problem: "expiry" });
    expect(cards.add({ ...CARD, cvc: "12" })).toMatchObject({ ok: false, problem: "cvc" });
    expect(cards.list()).toEqual([]);
  });

  it("updates the same PAN in place, removes a card, and stamps lastUsedAt", () => {
    const { dir } = store();
    const cards = new PaymentCards({ dataDir: dir });
    const added = cards.add({ ...CARD, name: "Old name" }) as { card: { id: string } };
    const renamed = cards.add({ ...CARD, name: "New name" }) as { card: { id: string } };
    expect(renamed.card.id).toBe(added.card.id);
    expect(cards.list()).toHaveLength(1);
    cards.markUsed(added.card.id);
    expect(cards.list()[0]!.lastUsedAt).toBeTypeOf("number");
    expect(cards.remove(added.card.id)).toBe(true);
    expect(cards.remove(added.card.id)).toBe(false);
    expect(cards.list()).toEqual([]);
  });
});

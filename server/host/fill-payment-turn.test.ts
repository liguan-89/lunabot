import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PaymentCards } from "../payment-cards.ts";
import { FakeLoginPage } from "../testing/fake-login-page.ts";
import type { Surface } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { createFillPaymentTurn, type FillPaymentTurnDeps } from "./fill-payment-turn.ts";

const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const bot = { id: "b1", name: "Buyer", browser: true } as unknown as BotRecord;
const PAN = "4242424242424242";

const CHECKOUT = `
  <form>
    <input name="cardnumber" autocomplete="cc-number">
    <input name="exp" autocomplete="cc-exp">
    <input name="cvc" autocomplete="cc-csc">
  </form>`;

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

type Held = { always?: boolean; tool: string; calls: Array<{ slug: string; arguments?: unknown }>; active: () => boolean };

function harness(over: Partial<FillPaymentTurnDeps> & { at?: Surface | null; cards?: PaymentCards; holdAnswer?: { ok: true; approved: boolean } | { ok: false; text: string } } = {}) {
  page = new FakeLoginPage("https://shop.test/checkout", CHECKOUT);
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => rect };
  page.window.HTMLElement.prototype.getBoundingClientRect = () => rect as never;
  const cards = over.cards ?? new PaymentCards({ dataDir: mkdtempSync(join(tmpdir(), "omb-fill-cards-")) });
  const held: Held[] = [];
  const remembered: Array<[string, string]> = [];
  const deps: FillPaymentTurnDeps = {
    place: () => (over.at === undefined ? "browser" : over.at),
    current: (b) => b,
    builtInBrowserOn: () => true,
    target: async () => ({ session: "bot-b1", spec: { command: "agent-browser", env: {} }, env: {} }),
    claim: () => true,
    withSecretInput: (_session, _spec, fill) => fill(),
    loginInput: () => ({ engine: (args) => page!.engine(args), insertText: (text) => page!.insertText(text) }),
    stepContext: () => ({ botId: "b1", botName: "Buyer", threadId: "t1", generation: "g1", turnId: () => null, record: false }),
    remember: (value, kind) => { remembered.push([kind, value]); },
    cards,
    hold: async (input) => { held.push(input as Held); return over.holdAnswer ?? { ok: true, approved: true }; },
    turnActive: () => true,
    ...over,
  };
  return { fill: createFillPaymentTurn(deps).fillPaymentForTurn, held, remembered, cards, page };
}

function cardsWith(...inputs: Parameters<PaymentCards["add"]>[0][]) {
  const cards = new PaymentCards({ dataDir: mkdtempSync(join(tmpdir(), "omb-fill-cards-")) });
  for (const input of inputs) cards.add(input);
  return cards;
}

describe("fill_payment always asks before a card touches the page", () => {
  it("holds for the person's answer even though the bot has Full access, then fills", async () => {
    const cards = cardsWith({ name: "Work", pan: PAN, expiry: "12/30", cvc: "123" });
    const { fill, held, page: p } = harness({ cards });
    const answer = await fill(bot, turn);
    expect(held).toHaveLength(1);
    expect(held[0]!.always).toBe(true);
    expect(held[0]!.tool).toBe("fill_payment");
    expect(JSON.stringify(held[0]!.calls)).not.toContain(PAN);
    expect(held[0]!.calls[0]).toMatchObject({ slug: "fill_payment", arguments: { card: "Work ····4242", host: "shop.test" } });
    expect(answer.ok).toBe(true);
    expect(p.typed).toEqual([PAN, "12/30", "123"]);
    expect(cards.list()[0]!.lastUsedAt).toBeTypeOf("number");
  });

  it("fills nothing when the person denies the card, and says so without a secret", async () => {
    const cards = cardsWith({ name: "Work", pan: PAN, expiry: "12/30", cvc: "123" });
    const { fill, page: p, remembered } = harness({ cards, holdAnswer: { ok: false, text: "The person denied this send." } });
    const answer = await fill(bot, turn);
    expect(answer).toEqual({ ok: false, text: "The person denied this send." });
    expect(p.typed).toEqual([]);
    expect(remembered).toEqual([]);
  });

  it("registers the PAN and CVC for transcript masking while the fill holds them", async () => {
    const cards = cardsWith({ name: "Work", pan: PAN, expiry: "12/30", cvc: "123" });
    const { fill, remembered } = harness({ cards });
    await fill(bot, turn);
    expect(remembered).toContainEqual(["password", PAN]);
    expect(remembered).toContainEqual(["password", "123"]);
  });
});

describe("which card a bot may spend with", () => {
  it("asks which card when several are saved and none was named", async () => {
    const cards = cardsWith({ name: "Work", pan: PAN, expiry: "12/30", cvc: "123" }, { name: "Personal", pan: "5555555555554444", expiry: "01/31", cvc: "321" });
    const { fill, held } = harness({ cards });
    const answer = await fill(bot, turn);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("Work ····4242");
    expect(answer.text).toContain("Personal ····4444");
    expect(held).toEqual([]);
  });

  it("picks a card by its last four digits, and only ever one the bot may use", async () => {
    const cards = cardsWith(
      { name: "Work", pan: PAN, expiry: "12/30", cvc: "123" },
      { name: "Personal", pan: "5555555555554444", expiry: "01/31", cvc: "321", bots: ["b2"] },
    );
    const { fill, held } = harness({ cards });
    const answer = await fill(bot, turn, "4444");
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('No saved card matches "4444"');
    expect(held).toEqual([]);
  });
});

describe("fill_payment away from the bot's own browser", () => {
  it.each(["local", "vm", "cloud"] as const)("refuses on %s and never holds a card", async (at) => {
    const cards = cardsWith({ name: "Work", pan: PAN, expiry: "12/30", cvc: "123" });
    const { fill, held } = harness({ at, cards });
    const answer = await fill(bot, turn);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("your own browser");
    expect(held).toEqual([]);
  });

  it("points at Settings → Keys when the bot has no card at all", async () => {
    const { fill, held } = harness({});
    const answer = await fill(bot, turn);
    expect(answer.text).toContain("No payment card is saved for you");
    expect(held).toEqual([]);
  });
});

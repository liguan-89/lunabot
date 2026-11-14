import { afterEach, describe, expect, it } from "vitest";

import { fillCard, type CardFillSecrets } from "./card-fill.ts";
import { FakeLoginPage } from "./testing/fake-login-page.ts";

// Obvious fakes only.
const CARD: CardFillSecrets = { pan: "4242424242424242", cvc: "123", expMonth: 12, expYear: 2030, holder: "Li Guan" };

const CHECKOUT = `
  <form action="/pay" method="post">
    <label>Card number <input id="cc" name="cardnumber" autocomplete="cc-number"></label>
    <label>Expiry <input id="exp" name="exp" autocomplete="cc-exp" placeholder="MM/YY"></label>
    <label>CVC <input id="cvc" name="cvc" autocomplete="cc-csc"></label>
    <label>Name <input id="holder" name="holder" autocomplete="cc-name"></label>
  </form>`;

const SPLIT_EXPIRY = `
  <form>
    <input name="pan" autocomplete="cc-number">
    <select name="expMonth"><option value=""></option><option value="12">12</option></select>
    <select name="expYear"><option value=""></option><option value="2030">2030</option></select>
    <input name="sec" autocomplete="cc-csc">
  </form>`;

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

function setup(url: string, html: string) {
  page = new FakeLoginPage(url, html);
  // happy-dom lays out nothing: every element measures 0x0, which card-fill reads as hidden.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => rect };
  page.window.HTMLElement.prototype.getBoundingClientRect = () => rect as never;
  return {
    page,
    fill: () => fillCard(CARD, { engine: (args) => page!.engine(args), insertText: (text) => page!.insertText(text) }),
  };
}

function expectNoSecret(outcome: unknown, current: FakeLoginPage, secrets: string[]) {
  const said = JSON.stringify(outcome);
  const commands = JSON.stringify(current.engineCalls);
  for (const secret of secrets) {
    expect(said).not.toContain(secret);
    expect(commands).not.toContain(secret);
  }
}

describe("fillCard", () => {
  it("finds the cc-* fields and types each value as real input, never inside an eval script", async () => {
    const { page, fill } = setup("https://shop.test/checkout", CHECKOUT);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, host: "shop.test", filled: ["number", "expiry", "cvc", "name"] });
    expect(page.typed).toEqual([CARD.pan, "12/30", CARD.cvc, "Li Guan"]);
    expect(page.field("#cc").value).toBe(CARD.pan);
    expect(page.field("#cvc").value).toBe(CARD.cvc);
    expectNoSecret(outcome, page, [CARD.pan, CARD.cvc]);
  });

  it("picks split month and year selects when the form has no single expiry box", async () => {
    const { page, fill } = setup("https://shop.test/checkout", SPLIT_EXPIRY);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["number", "expMonth", "expYear", "cvc"] });
    expect((page.field("select[name=expMonth]")).value).toBe("12");
    expect((page.field("select[name=expYear]")).value).toBe("2030");
    expect(page.typed).toEqual([CARD.pan, CARD.cvc]);
  });

  it("says a Stripe-style frame is out of reach instead of guessing at it", async () => {
    const { fill } = setup("https://shop.test/checkout", `<iframe src="https://js.stripe.com/v3/elements.html"></iframe>`);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: false, reason: "protected-frame", host: "shop.test" });
    expect(outcome.text).toContain("protected frame");
    expect(outcome.text).toContain("request_sign_in");
  });

  it("says there is nothing to fill on a page with no card fields", async () => {
    const { page, fill } = setup("https://shop.test/cart", `<input name="q" placeholder="search">`);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: false, reason: "no-fields" });
    expect(page.typed).toEqual([]);
  });

  it("never submits: the filled form waits for the bot to place the order itself", async () => {
    const { page, fill } = setup("https://shop.test/checkout", CHECKOUT);
    const outcome = await fill();
    expect(outcome.text).toContain("Nothing was submitted");
    expect(page.sent).toEqual([]);
  });
});

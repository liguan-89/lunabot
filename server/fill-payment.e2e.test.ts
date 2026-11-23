// A happy-dom checkout page behind the stand-in agent-browser: nothing reaches a real browser, the
// user's data or port 8799, and the PAN/CVC are obvious fakes that only ever ride the input relay.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { browserFixture } from "./testing/fake-browser-fixture.ts";

// Obvious fakes only. A four-digit CVC: HeldSecrets masks nothing shorter than MIN_SECRET (4), so a
// three-digit code would stay in a careless reply's transcript.
const PAN = "4242424242424242";
const CVC = "9876";
const CHECKOUT = `
  <form action="/pay" method="post">
    <label>Card number <input id="num" name="cardNumber" autocomplete="cc-number"></label>
    <label>Expiry <input id="exp" name="expiry" autocomplete="cc-exp"></label>
    <label>Security code <input id="cvc" name="cvc" autocomplete="cc-csc"></label>
    <label>Name on card <input id="holder" name="holder" autocomplete="cc-name"></label>
    <button type="submit">Pay now</button>
  </form>`;

it.skipIf(process.platform === "win32")("fill_payment waits on the spend card, types the saved card only after an allow and submits nothing", async () => {
  const browser = await browserFixture("https://shop.example.com/checkout", undefined, CHECKOUT);
  const { page, api, evidence, answered } = browser;
  // happy-dom lays out nothing: every element measures 0x0, which card-fill reads as hidden.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => rect };
  page.window.HTMLElement.prototype.getBoundingClientRect = () => rect as never;
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Payer" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    const added = await api("POST", "/api/payment-cards", { name: "Smoke Visa", pan: PAN, expiry: "12/2030", cvc: CVC, holder: "Ada Lovelace" });
    expect(added).toMatchObject({ status: 200, body: { card: { name: "Smoke Visa", last4: "4242", brand: "visa" } } });
    expect(added.text).not.toContain(PAN);
    expect(added.text).not.toContain(CVC);

    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "fill_payment", arguments: {}, expectError: true }], reply: "You said no, so I paid nothing." },
      // A careless bot repeats the card in its reply; the transcript must not keep it.
      { steps: [{ tool: "fill_payment", arguments: {} }], reply: `Filled. The card was ${PAN} ${CVC}.` },
    ] } }));

    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    const unansweredApproval = async () => (await messages()).find((message) => message.card?.outboundRequest && !message.card.answered);

    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Pay for my order.", "--url", browser.base]);
    await expect.poll(async () => Boolean(await unansweredApproval()), { timeout: 20_000 }).toBe(true);
    const deny = (await unansweredApproval())!;
    // The spend card shows the card's name and last four and the checkout's host, never the PAN or CVC.
    expect(deny.card.subtitle).toContain("Smoke Visa ····4242");
    expect(deny.card.subtitle).toContain("shop.example.com");
    expect(JSON.stringify(deny.card)).not.toContain(PAN);
    expect(JSON.stringify(deny.card)).not.toContain(CVC);

    const refused = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: deny.card.requestId, behavior: "deny" });
    expect(refused.status).toBe(200);
    expect(await runControlLunabot(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", browser.base])).toMatchObject({ status: "settled" });
    const [denied] = answered(0, "fill_payment");
    expect(denied.isError).toBeTruthy();
    expect(page.typed).toEqual([]);
    expect(page.state).toEqual({});

    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Go ahead and pay.", "--url", browser.base]);
    await expect.poll(async () => Boolean(await unansweredApproval()), { timeout: 20_000 }).toBe(true);
    const allow = (await unansweredApproval())!;
    const accepted = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: allow.card.requestId, behavior: "allow" });
    expect(accepted.status).toBe(200);
    expect(await runControlLunabot(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", browser.base])).toMatchObject({ status: "settled" });

    const [filled] = answered(1, "fill_payment");
    expect(filled.isError).toBeFalsy();
    expect(filled.content[0].text).toContain("Filled the card number, expiry, security code, cardholder name on shop.example.com");
    expect(filled.content[0].text).toContain("Nothing was submitted");
    expect(page.typed).toEqual([PAN, "12/30", CVC, "Ada Lovelace"]);
    expect(page.state).toMatchObject({ cardNumber: PAN, expiry: "12/30", cvc: CVC, holder: "Ada Lovelace" });
    expect(page.sent).toEqual([]);

    // The secrets went through the input relay only: no engine command, plan evidence, card or transcript carries them.
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PAN);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(CVC);
    expect(JSON.stringify(evidence())).not.toContain(PAN);
    expect(JSON.stringify(evidence())).not.toContain(CVC);
    const transcript = JSON.stringify(await messages());
    expect(transcript).not.toContain(PAN);
    expect(transcript).not.toContain(CVC);
    const reply = (await messages()).find((message) => message.role === "bot" && String(message.text).startsWith("Filled."));
    expect(reply.text).toBe("Filled. The card was •••••• ••••••.");
    expect(readFileSync(join(browser.fixture.info.dataDir, "payment-cards.json.enc")).includes(Buffer.from(PAN))).toBe(false);
    const cards = await api("GET", "/api/payment-cards");
    expect(cards.body.cards).toEqual([expect.objectContaining({ name: "Smoke Visa", last4: "4242" })]);
    expect(cards.text).not.toContain(PAN);
    expect(cards.text).not.toContain(CVC);
  } finally {
    await browser.close();
  }
}, 120_000);

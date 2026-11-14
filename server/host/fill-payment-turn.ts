// fill_payment for one turn: the person confirms the spend on a card (a standing grant settles it for
// them), then the server types the saved card into the checkout page itself — the PAN and CVC are never
// in the tool call, its result or the transcript.
import type { Surface } from "../../shared/wire.ts";
import type { PaymentCardView } from "../../shared/payment-card.ts";
import { BROWSER_CONTROL_REFUSAL } from "../browser-runtime.ts";
import { fillCard } from "../card-fill.ts";
import type { StepContext } from "../browser-steps.ts";
import type { OutboundHold, OutboundHoldBot } from "../outbound-hold.ts";
import type { PaymentCards } from "../payment-cards.ts";
import { redactSecretsInText } from "../redact.ts";
import type { BotRecord } from "../store.ts";

type Spec = { command: string; env: Record<string, string> };
type Turn = { botId: string; threadId: string; generation: string };
type Answer = { ok: boolean; text: string };

export interface FillPaymentTurnDeps {
  place(bot: BotRecord, threadId: string): Surface | null;
  current(bot: BotRecord, threadId: string): BotRecord;
  builtInBrowserOn(): boolean;
  target(bot: BotRecord, threadId: string): Promise<{ session: string; spec: Spec; env: NodeJS.ProcessEnv } | null>;
  claim(turn: Turn, resource: string): boolean;
  withSecretInput<T extends { ok: boolean; text: string; host?: string; filled?: string[]; held?: import("../browser-secret-hold.ts").SecretHold }>(session: string, spec: Spec, fill: () => Promise<T>, ctx: StepContext): Promise<T>;
  loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<import("../login-fill.ts").FillLoginDeps, "engine" | "insertText">;
  stepContext(bot: BotRecord, turn: Turn): StepContext;
  /** Registers a value for transcript masking while the fill holds it. */
  remember(value: string, kind: "password" | "code"): void;
  cards: Pick<PaymentCards, "list" | "secrets" | "markUsed">;
  hold: OutboundHold["hold"];
  /** False once the turn that asked has ended: an answered card must not fill into a dead turn's page. */
  turnActive?(turn: Turn): boolean;
}

const ONLY_IN_BROWSER = "fill_payment types a card only into a checkout page of your own browser, never anywhere else";

export function createFillPaymentTurn(deps: FillPaymentTurnDeps) {
  function pick(cards: PaymentCardView[], label: string | undefined): { card: PaymentCardView } | { error: string } {
    if (!label) {
      if (cards.length === 1) return { card: cards[0]! };
      return { error: `Several cards are saved (${cards.map((c) => `${c.name} ····${c.last4}`).join(", ")}). Call fill_payment with the card's name or last four digits.` };
    }
    const want = label.trim().toLowerCase();
    const found = cards.filter((c) => c.last4 === want || c.name.toLowerCase().includes(want));
    if (found.length === 1) return { card: found[0]! };
    if (!found.length) return { error: `No saved card matches "${label}". Saved: ${cards.map((c) => `${c.name} ····${c.last4}`).join(", ")}.` };
    return { error: `"${label}" matches several cards (${found.map((c) => `${c.name} ····${c.last4}`).join(", ")}). Give its last four digits.` };
  }

  async function fillPaymentForTurn(bot: BotRecord, turn: Turn, rawLabel?: unknown, rawCard?: unknown): Promise<Answer> {
    const threadId = turn.threadId;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim().slice(0, 80) : undefined;
    const cardId = typeof rawCard === "string" && rawCard.trim() ? rawCard.trim().slice(0, 128) : undefined;
    const place = deps.place(bot, threadId);
    const current = deps.current(bot, threadId);
    if (place !== "browser") {
      return { ok: false, text: `${ONLY_IN_BROWSER}, and this conversation has none open. Move it to the browser, open the checkout page, then call fill_payment again.` };
    }
    if (current.browser === false || current.computer === "off" || !deps.builtInBrowserOn()) {
      return { ok: false, text: "The built-in browser is off for you here, so fill_payment has nothing to fill. Ask the person to pay themselves." };
    }
    const cards = deps.cards.list(current.id);
    if (!cards.length) {
      return { ok: false, text: "No payment card is saved for you. The person adds one under Settings → Keys → Payment cards, and picks which bots may use it." };
    }
    const picked = cardId
      ? (cards.find((c) => c.id === cardId) ? { card: cards.find((c) => c.id === cardId)! } : { error: "That card is not saved for you any more. List what is saved, or ask for a new one." })
      : pick(cards, label);
    if ("error" in picked) return { ok: false, text: picked.error };
    const card = picked.card;
    const secrets = deps.cards.secrets(card.id, current.id);
    if (!secrets) return { ok: false, text: `The card ${card.name} is not saved for you. The person picks which bots may use it under Settings → Keys.` };
    const browser = await deps.target(current, threadId);
    if (!browser) return { ok: false, text: "The browser is not available on this computer right now. Ask the person to pay themselves." };
    const { session, spec, env } = browser;
    if (!deps.claim(turn, `browser:${session}`)) {
      return { ok: false, text: "Another conversation is using this browser. Wait until it finishes, then call fill_payment again." };
    }
    const input = deps.loginInput(session, spec, env);
    const url = (await input.engine(["get", "url"]))?.url;
    const host = (() => { try { return new URL(String(url)).host; } catch { return "this page"; } })();
    // Money always asks: the person's tap on the card (or a live grant covering it) is the spend
    // approval — never a Full-access free pass.
    const held = await deps.hold({
      bot: current as OutboundHoldBot,
      threadId,
      tool: "fill_payment",
      // The card's arguments land on the approval card verbatim: name and last4 only, never the PAN.
      calls: [{ slug: "fill_payment", arguments: { card: `${card.name} ····${card.last4}`, host } }],
      opaque: false,
      fullAccess: false,
      always: true,
      active: () => deps.turnActive?.(turn) !== false,
    });
    if (!held.ok) return { ok: false, text: held.text };
    deps.remember(secrets.pan, "password");
    deps.remember(secrets.cvc, "password");
    try {
      const outcome = await deps.withSecretInput(session, spec, () => fillCard(secrets, input), deps.stepContext(current, turn));
      if (outcome.ok) deps.cards.markUsed(card.id);
      return { ok: outcome.ok, text: outcome.text };
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL) {
        return { ok: false, text: "The person is using this browser right now. Wait for them to hand it back, then call fill_payment again." };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Could not fill the card: ${redactSecretsInText(reason)} Ask the person to pay themselves if it keeps failing.` };
    }
  }

  return { fillPaymentForTurn };
}

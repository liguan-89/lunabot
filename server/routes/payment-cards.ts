// The person's payment-card routes: list (display fields only), add, remove. A card's PAN/CVC can be
// written once, never read back over any route — fill_payment spends with it, nothing shows it.
import { ownerOrAdmin } from "../request-auth.ts";
import { userError } from "../user-errors.ts";
import type { PaymentCards } from "../payment-cards.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createPaymentCardRoutes(deps: {
  cards: Pick<PaymentCards, "list" | "add" | "remove">;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const remove = path.match(/^\/api\/payment-cards\/([\w-]{1,128})$/);
    if (path !== "/api/payment-cards" && !remove) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, userError("serverError.chat.ownerOrAdmin"));
    if (method === "GET" && path === "/api/payment-cards") {
      return json(res, 200, { cards: deps.cards.list() });
    }
    if (method === "POST" && path === "/api/payment-cards") {
      const body = await readBody(req, 4096);
      const result = deps.cards.add({
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        pan: typeof body?.pan === "string" ? body.pan : "",
        expiry: typeof body?.expiry === "string" ? body.expiry : "",
        cvc: typeof body?.cvc === "string" ? body.cvc : "",
        ...(typeof body?.holder === "string" ? { holder: body.holder } : {}),
        ...(Array.isArray(body?.bots) && body.bots.every((id: unknown) => typeof id === "string") ? { bots: body.bots } : {}),
      });
      if (!result.ok) return json(res, 400, { error: `invalid payment card: ${result.problem}` });
      return json(res, 200, { card: result.card });
    }
    if (method === "DELETE" && remove) {
      return deps.cards.remove(remove[1]!) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such card" });
    }
    return json(res, 405, { error: "method not allowed" });
  };
}

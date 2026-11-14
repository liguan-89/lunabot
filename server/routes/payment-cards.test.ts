import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PaymentCards } from "../payment-cards.ts";
import { createPaymentCardRoutes } from "./payment-cards.ts";

const PAN = "4242424242424242";
const owner = { kind: "loopback", scopes: ["admin", "client"] } as never;
const guest = { kind: "session", scopes: ["client"] } as never;

function call(handler: ReturnType<typeof createPaymentCardRoutes>, method: string, path: string, body?: unknown, auth: unknown = owner) {
  let status = 0; let payload: unknown;
  return handler({ req: {}, res: {}, path, method, auth: auth as never, readBody: async () => body ?? {}, json: (_r: unknown, s: number, value: never) => { status = s; payload = value; } } as never).then(() => ({ status, payload: payload as Record<string, unknown> }));
}

function route() {
  const cards = new PaymentCards({ dataDir: mkdtempSync(join(tmpdir(), "omb-card-route-")) });
  return { cards, handler: createPaymentCardRoutes({ cards }) };
}

describe("payment card routes", () => {
  it("adds, lists and removes a card for the owner, never handing a PAN or CVC back", async () => {
    const { handler } = route();
    const added = await call(handler, "POST", "/api/payment-cards", { name: "Work", pan: PAN, expiry: "12/30", cvc: "123" });
    expect(added.status).toBe(200);
    expect(JSON.stringify(added.payload)).not.toContain(PAN);
    expect(added.payload.card).toMatchObject({ name: "Work", brand: "visa", last4: "4242" });
    const listed = await call(handler, "GET", "/api/payment-cards");
    expect(listed.payload.cards).toHaveLength(1);
    const id = (added.payload.card as { id: string }).id;
    expect(await call(handler, "DELETE", `/api/payment-cards/${id}`)).toEqual({ status: 200, payload: { ok: true } });
    expect(await call(handler, "DELETE", `/api/payment-cards/${id}`)).toEqual({ status: 404, payload: { error: "no such card" } });
  });

  it("answers 400 on a card that fails its checks", async () => {
    const { handler } = route();
    const refused = await call(handler, "POST", "/api/payment-cards", { pan: "1111", expiry: "soon", cvc: "x" });
    expect(refused.status).toBe(400);
  });

  it("is owner-or-admin only", async () => {
    const { handler } = route();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const path = method === "DELETE" ? "/api/payment-cards/c1" : "/api/payment-cards";
      expect((await call(handler, method, path, {}, guest)).status).toBe(403);
    }
  });
});

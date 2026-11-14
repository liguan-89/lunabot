import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import type { DecisionRow } from "./decision-log.ts";
import { activeGrants, createGrantHost, grantCovering, type PermissionGrant } from "./permission-grants.ts";
import type { Store } from "./store.ts";

const owner = { kind: "loopback", scopes: ["admin", "client"] } as never;
const guest = { kind: "loopback", scopes: ["client"], trust: "service" } as never;

const grant = (over: Partial<PermissionGrant> = {}): PermissionGrant => ({
  id: "g1", text: "billing mails may be sent", expiresAt: 2_000, createdAt: 1_000, ...over,
});

describe("activeGrants", () => {
  it("drops expired rows and keeps live ones", () => {
    const cfg = { decisions: { grants: [grant(), grant({ id: "g2", expiresAt: 500 })] } } as AppConfig;
    expect(activeGrants(cfg, 1_000).map((one) => one.id)).toEqual(["g1"]);
    expect(activeGrants(cfg, 3_000)).toEqual([]);
    expect(activeGrants({} as AppConfig, 1_000)).toEqual([]);
  });
});

describe("grantCovering", () => {
  const request = { tool: "GMAIL_SEND_EMAIL", summary: "Send invoice to Ada" };

  const deciderReturning = (choice: string, pTop = 0.9) => ({
    ask: vi.fn(async () => ({ ok: true as const, provider: "fake", answers: { grant: { type: "choice" as const, choice, pTop, margin: 0.5, probabilities: {} } }, latencyMs: 1 })),
  });

  it("returns the grant the helper picked confidently", async () => {
    const decider = deciderReturning("g1");
    const covered = await grantCovering({ decider, request, grants: [grant()], model: "m" });
    expect(covered?.id).toBe("g1");
    const [state, questions] = decider.ask.mock.calls[0]!.slice(1) as never[];
    expect(JSON.stringify(state)).toContain("GMAIL_SEND_EMAIL");
    expect(Object.keys((questions as { grant: { options: object } }).grant.options)).toContain("g1");
  });

  it("covers nothing on none, on a weak pick, or on a helper failure", async () => {
    for (const [choice, p] of [["none", 0.95], ["g1", 0.4]] as const) {
      expect(await grantCovering({ decider: deciderReturning(choice, p), request, grants: [grant()] })).toBeNull();
    }
    const failing = { ask: async () => ({ ok: false as const, reason: "http_error" as const }) };
    expect(await grantCovering({ decider: failing, request, grants: [grant()] })).toBeNull();
    expect(await grantCovering({ decider: deciderReturning("g1"), request, grants: [] })).toBeNull();
  });
});

describe("createGrantHost", () => {
  function setup() {
    const messages: Array<{ id: string; grantProposal?: { id: string; text: string; expiresAt: number; answer?: string } } & Record<string, unknown>> = [];
    const appended: Array<Record<string, unknown>> = [];
    const decisions: Array<Omit<DecisionRow, "at">> = [];
    let saved: PermissionGrant[] | undefined;
    const cfg = { decisions: { grants: [] as PermissionGrant[] } };
    let now = 1_000;
    const store = {
      appendMessage: (_t: string, message: Record<string, unknown>) => {
        const row = { ...message, id: `m${messages.length + 1}` } as never;
        messages.push(row);
        appended.push(row);
        return row;
      },
      botByThread: () => ({ id: "b1", name: "Scout" }),
      messagesFor: () => messages,
      patchMessage: (_t: string, id: string, patch: Record<string, unknown>) => {
        const row = messages.find((one) => one.id === id);
        if (row) Object.assign(row, patch);
        return null;
      },
    } as unknown as Store;
    const host = createGrantHost({
      store,
      cfg: () => cfg,
      save: (patch) => { saved = patch.grants; cfg.decisions.grants = patch.grants; },
      decide: (row) => decisions.push(row),
      now: () => now,
    });
    return { host, messages, appended, decisions, cfg, saved: () => saved, setNow: (value: number) => { now = value; } };
  }

  it("proposes a card the person confirms into a live grant", () => {
    const s = setup();
    const { proposal, message } = s.host.propose({ bot: { id: "b1" } as never, threadId: "t1", text: "billing mails may be sent", expiresAt: 5_000 });
    expect(message.grantProposal).toMatchObject({ id: proposal.id, text: "billing mails may be sent", expiresAt: 5_000 });

    expect(s.host.answer({ threadId: "t1", messageId: message.id, auth: guest, answer: "granted" })).toBe("not-owner");
    expect(s.host.answer({ threadId: "t1", messageId: "nope", auth: owner, answer: "granted" })).toBe("unknown");

    expect(s.host.answer({ threadId: "t1", messageId: message.id, auth: owner, answer: "granted" })).toBe("granted");
    expect(s.messages[0]!.grantProposal?.answer).toBe("granted");
    expect(s.saved()).toMatchObject([{ id: proposal.id, text: "billing mails may be sent", expiresAt: 5_000 }]);
    expect(activeGrants(s.cfg as never, 2_000)).toHaveLength(1);
    expect(s.decisions).toMatchObject([{ decision: "user-approved", source: "temporary-grant", rule: proposal.id }]);
    expect(s.appended.some((row) => row.kind === "activity" && String((row.tool as { name: string }).name).startsWith("Granted until"))).toBe(true);
    // Once answered it does not answer again.
    expect(s.host.answer({ threadId: "t1", messageId: message.id, auth: owner, answer: "refused" })).toBe("unknown");
  });

  it("a refused card writes no grant, and a stale card answers as expired", () => {
    const s = setup();
    const { message } = s.host.propose({ bot: { id: "b1" } as never, threadId: "t1", text: "x", expiresAt: 3_000 });
    expect(s.host.answer({ threadId: "t1", messageId: message.id, auth: owner, answer: "refused" })).toBe("refused");
    expect(s.saved()).toBeUndefined();
    expect(s.cfg.decisions.grants).toEqual([]);

    const stale = s.host.propose({ bot: { id: "b1" } as never, threadId: "t1", text: "y", expiresAt: 1_500 });
    s.setNow(2_000);
    expect(s.host.answer({ threadId: "t1", messageId: stale.message.id, auth: owner, answer: "granted" })).toBe("expired");
    expect(stale.message.grantProposal?.answer).toBe("expired");
    expect(s.cfg.decisions.grants).toEqual([]);
  });
});

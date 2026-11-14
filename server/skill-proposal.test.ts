import { describe, expect, it, vi } from "vitest";

import { deciderDraftEngine, draftSkillProposal, hasPendingSkillProposal, skillWorthProposing } from "./skill-proposal.ts";
import type { AppConfig } from "./config.ts";
import type { Decider } from "./decider/index.ts";
import type { ReviewEngine, ReviewSkill } from "./skill-review.ts";

const SKILL_MD = "---\nname: file-expense\ndescription: Files an expense in the company portal.\n---\n\n# File expense\n";
const skill = (over: Partial<ReviewSkill> = {}): ReviewSkill => ({ name: "expenses", description: "Expense filing", editable: true, enabled: true, sha256: "s1", ...over });

const decider = (p: number, ok = true) => ({
  ask: vi.fn(async () => (ok
    ? { ok: true, provider: "openrouter", answers: { worth: { type: "yesno", p } }, latencyMs: 1 }
    : { ok: false, provider: "openrouter", reason: "http_error" })) as unknown as Decider["ask"],
});

describe("hasPendingSkillProposal", () => {
  it("is true only while a skill card is unanswered", () => {
    const request = { title: "t", subtitle: "s", options: ["Enable", "Deny"], skillRequest: { name: "x" } as never };
    expect(hasPendingSkillProposal([{ card: request }])).toBe(true);
    expect(hasPendingSkillProposal([{ card: { ...request, answered: "allow" } }])).toBe(false);
    expect(hasPendingSkillProposal([{ card: { ...request, dismissed: true } }])).toBe(false);
    expect(hasPendingSkillProposal([{ card: { title: "t", subtitle: "s", options: [] } }])).toBe(false);
    expect(hasPendingSkillProposal([])).toBe(false);
  });
});

describe("skillWorthProposing", () => {
  it("passes only a confident yes and fails closed", async () => {
    const turnText = "person: file the Acme invoice\nbot: done, filed under March\n[tools: browser, fs.write]";
    expect(await skillWorthProposing({ decider: decider(0.9), skills: [skill()], turnText })).toBe(true);
    expect(await skillWorthProposing({ decider: decider(0.4), skills: [skill()], turnText })).toBe(false);
    expect(await skillWorthProposing({ decider: decider(0.9, false), skills: [skill()], turnText })).toBe(false);
    expect(await skillWorthProposing({ decider: decider(0.9), skills: [skill()], turnText: "  " })).toBe(false);

    const spy = decider(0.9);
    await skillWorthProposing({ decider: spy, skills: [skill({ description: "x".repeat(500) })], turnText });
    const state = vi.mocked(spy.ask).mock.calls[0]![1] as { skills: string; turn: string };
    expect(state.skills).toContain("expenses");
    expect(state.turn).toContain("file the Acme invoice");
  });
});

describe("draftSkillProposal", () => {
  const messages = [
    { role: "user", kind: "text", text: "File the Acme invoice", turnId: "t1" },
    { role: "bot", kind: "activity", tool: { name: "browser", ok: true }, turnId: "t1" },
    { role: "bot", kind: "text", text: "Filed under March.", turnId: "t1" },
  ] as never[];

  it("returns parsed changes the engine produced", async () => {
    const engine: ReviewEngine = { generateText: vi.fn(async () => `{"changes":[{"action":"create","skill_md":${JSON.stringify(SKILL_MD)},"gist":"new recipe"}],"note":"saved"}`) };
    const changes = await draftSkillProposal({ engine, bot: { id: "b1", name: "Scout" }, transcript: { messages, room: false }, skills: [skill()] });
    expect(changes).toEqual([{ action: "create", name: "file-expense", skillMd: SKILL_MD, gist: "new recipe" }]);
  });

  it("returns nothing without an engine or when the draft call fails", async () => {
    expect(await draftSkillProposal({ engine: null, bot: { id: "b1", name: "Scout" }, transcript: { messages, room: false }, skills: [] })).toEqual([]);
    const engine: ReviewEngine = { generateText: async () => { throw new Error("boom"); } };
    expect(await draftSkillProposal({ engine, bot: { id: "b1", name: "Scout" }, transcript: { messages, room: false }, skills: [] })).toEqual([]);
  });
});

describe("deciderDraftEngine", () => {
  const openrouterCfg = (over: Record<string, unknown> = {}): AppConfig => ({
    decider: { enabled: true, provider: "openrouter", openrouterKey: "k", openrouterModel: "vendor/model", openrouterBaseUrl: "http://127.0.0.1:9/v1", ...over },
  } as AppConfig);

  it("exists only for an enabled own OpenRouter account", () => {
    expect(deciderDraftEngine(openrouterCfg())).not.toBeNull();
    expect(deciderDraftEngine(openrouterCfg({ enabled: false }))).toBeNull();
    expect(deciderDraftEngine(openrouterCfg({ provider: "off" }))).toBeNull();
    expect(deciderDraftEngine({} as AppConfig)).toBeNull();
    expect(deciderDraftEngine({ decider: { enabled: true, provider: "jev", key: "k" } } as AppConfig)).toBeNull();
    expect(deciderDraftEngine({ decider: { enabled: true, workersAiToken: "t", workersAiAccountId: "a".repeat(32) } } as AppConfig)).toBeNull();
  });

  it("posts a plain chat completion to the account's own base URL", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ choices: [{ message: { content: "drafted" } }] }), { status: 200 });
    }));
    try {
      const engine = deciderDraftEngine(openrouterCfg(), { model: "other/model" })!;
      expect(await engine.generateText("the prompt")).toBe("drafted");
      expect(calls).toEqual([{ url: "http://127.0.0.1:9/v1/chat/completions", body: { model: "other/model", messages: [{ role: "user", content: "the prompt" }] }, auth: "Bearer k" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a non-200 or a bodyless reply, so the proposal stays silent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    try {
      await expect(deciderDraftEngine(openrouterCfg())!.generateText("p")).rejects.toThrow("500");
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })));
    try {
      await expect(deciderDraftEngine(openrouterCfg())!.generateText("p")).rejects.toThrow("no text");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

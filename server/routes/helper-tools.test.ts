// The decide and extract tools' internal route: a plain "not set up", strict shapes, files only from the bot's own
// folders, and typed answers. The decider and extractor are fakes: no model is called.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Decider } from "../decider/index.ts";
import type { Extractor } from "../extractor/index.ts";
import { createHelperToolRoutes, HELPER_MESSAGES } from "./helper-tools.ts";
import { PASS } from "./table.ts";

const home = mkdtempSync(join(tmpdir(), "omb-helper-tools-"));
const work = join(home, "work");
const elsewhere = join(home, "elsewhere");
mkdirSync(work);
mkdirSync(elsewhere);
writeFileSync(join(work, "invoice.txt"), "Invoice INV-2291, total $1,080.00");
writeFileSync(join(work, "receipt.png"), Buffer.from("iVBORw0KGgo=", "base64"));
writeFileSync(join(work, "scan.pdf"), "%PDF-1.7");
writeFileSync(join(elsewhere, "secret.txt"), "not yours");

type Ask = Decider["ask"];
type Choose = Decider["choose"];
type Extract = Extractor["extract"];

async function call(path: string, body: unknown, deps: { ask?: Ask; choose?: Choose; extract?: Extract } = {}) {
  const ask = vi.fn<Ask>(deps.ask ?? (async () => ({ ok: false, reason: "disabled" } as never)));
  const choose = vi.fn<Choose>(deps.choose ?? (async () => ({ ok: false, reason: "disabled" } as never)));
  const extract = vi.fn<Extract>(deps.extract ?? (async () => ({ ok: false, reason: "disabled" })));
  const route = createHelperToolRoutes({ decider: { ask: ask as unknown as Ask, choose: choose as unknown as Choose }, extractor: { extract } });
  const json = vi.fn();
  const res = {} as never;
  const outcome = await route({ method: "POST", path, res, json, botId: "bot-1", readBody: async () => body, folders: async () => ({ roots: [work], vmWorkspace: null }) });
  const [, status, payload] = json.mock.calls[0] ?? [];
  return { outcome, status: status as number | undefined, payload: payload as { text?: string; error?: string } | undefined, ask, choose, extract };
}

const QUESTIONS = {
  team: { type: "choice", instructions: "Which team?", options: { billing: "Money", technical: "Outages" } },
  urgent: { type: "yesno", instructions: "Is it urgent?" },
};

describe("decide", () => {
  it("says plainly that it is not set up, and how to set it up", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "Checkout is down", questions: QUESTIONS });
    expect(status).toBe(409);
    expect(payload?.error).toBe(HELPER_MESSAGES.decideOff);
    expect(payload?.error).toContain("Settings → Decision and extraction");
  });

  it("asks as botDecide, carefully, and answers with rounded probabilities", async () => {
    const { status, payload, ask } = await call("/api/internal/helpers/decide", { state: "Checkout is down", questions: QUESTIONS }, {
      ask: (async () => ({
        ok: true, provider: "workersai", latencyMs: 40,
        answers: { team: { type: "choice", choice: "technical", pTop: 0.9512, margin: 0.9, probabilities: { technical: 0.9512, billing: 0.0488 } }, urgent: { type: "yesno", p: 0.934 } },
      })) as never,
    });
    expect(status).toBe(200);
    expect(ask).toHaveBeenCalledWith("botDecide", "Checkout is down", {
      team: { type: "choice", instructions: "Which team?", options: { billing: "Money", technical: "Outages" } },
      urgent: { type: "yesno", instructions: "Is it urgent?" },
    }, expect.objectContaining({ careful: true }));
    const [line] = payload!.text!.split("\n");
    expect(JSON.parse(line!)).toEqual({
      answers: { team: { choice: "technical", p: 0.95, probabilities: { technical: 0.95, billing: 0.05 } }, urgent: { yes: 0.93 } },
      by: "Cloudflare Workers AI",
    });
  });

  it.each([
    ["no questions", { state: "x", questions: {} }, "questions must be"],
    ["a choice with no options", { state: "x", questions: { a: { type: "choice", instructions: "Which?" } } }, "a choice needs options"],
    ["an unknown type", { state: "x", questions: { a: { type: "guess", instructions: "Which?" } } }, "type is choice, yesno or score"],
    ["nine questions", { state: "x", questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, { type: "yesno", instructions: "Is it?" }])) }, "Keep to 8 questions"],
    ["an empty state", { state: "", questions: QUESTIONS }, "Keep to 8 questions"],
  ])("refuses %s before any model is asked", async (_name, body, error) => {
    const { status, payload, ask } = await call("/api/internal/helpers/decide", body);
    expect(status).toBe(400);
    expect(payload?.error).toContain(error);
    expect(ask).not.toHaveBeenCalled();
  });

  it("too large says so, and that the same again will not work", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "x", questions: QUESTIONS }, { ask: (async () => ({ ok: false, reason: "too_large", status: 413 })) as never });
    expect(status).toBe(502);
    expect(payload?.error).toMatch(/too large .* will not work/);
  });

  it("a failing model says what to do, never the vendor's words", async () => {
    const { status, payload } = await call("/api/internal/helpers/decide", { state: "x", questions: QUESTIONS }, { ask: (async () => ({ ok: false, reason: "rate_limited", status: 429 })) as never });
    expect(status).toBe(502);
    expect(payload?.error).toMatch(/used up for now/);
  });
});

describe("select_tool", () => {
  const TOOLS = [{ name: "read_file", description: "Read a file" }, { name: "browser_click", description: "Click an element" }];
  const picked = (choice: string, pTop: number, probabilities: Record<string, number> = { read_file: 0.92, browser_click: 0.08 }) => (async () => ({
    ok: true, provider: "jev", latencyMs: 10,
    answers: { type: "choice", choice, pTop, margin: 0.8, probabilities },
  })) as never;

  it("asks the decision model which tool fits, keyed by the tool's own name, and answers with it", async () => {
    const { status, payload, choose } = await call("/api/internal/helpers/select-tool", { task: "Read the invoice", tools: TOOLS }, { choose: picked("read_file", 0.92) });
    expect(status).toBe(200);
    expect(choose).toHaveBeenCalledWith("toolSelection", { task: "Read the invoice" }, {
      instructions: expect.stringContaining("Read the invoice"),
      options: { read_file: "read_file: Read a file", browser_click: "browser_click: Click an element", none: expect.any(String) },
    }, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(JSON.parse(payload!.text!.split("\n")[0]!)).toEqual({ tool: "read_file", p: 0.92, by: "Jev" });
  });

  it("does not pretend a choice when the model is unsure", async () => {
    const { status, payload } = await call("/api/internal/helpers/select-tool", { task: "Read the invoice", tools: TOOLS }, { choose: picked("read_file", 0.51) });
    expect(status).toBe(200);
    expect(JSON.parse(payload!.text!.split("\n")[0]!)).toMatchObject({ tool: null, p: 0.51 });
    expect(payload!.text).toContain("not sure");
  });

  it("honours none of these tools", async () => {
    const { status, payload } = await call("/api/internal/helpers/select-tool", { task: "Do something else", tools: TOOLS }, { choose: picked("none", 0.9, { read_file: 0.1, browser_click: 0.1, none: 0.8 }) });
    expect(status).toBe(200);
    expect(JSON.parse(payload!.text!.split("\n")[0]!)).toEqual({ tool: null, p: 0.9, by: "Jev" });
    expect(payload!.text).toContain("none of these tools fits");
  });

  it("says plainly when tool selection is off", async () => {
    const { status, payload } = await call("/api/internal/helpers/select-tool", { task: "Read the invoice", tools: TOOLS }, { choose: (async () => ({ ok: false, reason: "job_off" })) as never });
    expect(status).toBe(409);
    expect(payload?.error).toBe(HELPER_MESSAGES.toolSelectionOff);
  });

  it.each([
    ["one tool", { task: "Read it", tools: [TOOLS[0]] }, "2 to 50 tools"],
    ["no task", { task: "", tools: TOOLS }, "task must be"],
    ["a duplicate name", { task: "Read it", tools: [TOOLS[0], TOOLS[0]] }, "listed twice"],
    ["a blank name", { task: "Read it", tools: [TOOLS[0], { name: "" }] }, "needs a name"],
  ])("refuses %s before any model is asked", async (_name, body, error) => {
    const { status, payload, choose } = await call("/api/internal/helpers/select-tool", body);
    expect(status).toBe(400);
    expect(payload?.error).toContain(error);
    expect(choose).not.toHaveBeenCalled();
  });
});

describe("extract", () => {
  const FIELDS = { total: { type: "number" }, paid: { type: "boolean" } };
  const answered: Extract = async () => ({ ok: true, provider: "jev", values: { total: 1080, paid: null }, latencyMs: 30 });

  it("says plainly that it is not set up", async () => {
    const { status, payload } = await call("/api/internal/helpers/extract", { fields: FIELDS, text: "Total $1,080" });
    expect(status).toBe(409);
    expect(payload?.error).toBe(HELPER_MESSAGES.extractOff);
  });

  it("reads text as botExtract and answers with typed values", async () => {
    const { status, payload, extract } = await call("/api/internal/helpers/extract", { fields: FIELDS, text: "Total $1,080" }, { extract: answered });
    expect(status).toBe(200);
    expect(extract).toHaveBeenCalledWith("botExtract", FIELDS, { text: "Total $1,080" }, expect.anything());
    expect(JSON.parse(payload!.text!.split("\n")[0]!)).toEqual({ values: { total: 1080, paid: null }, by: "Jev" });
  });

  it("reads a text file or an image from the bot's working folder", async () => {
    const text = await call("/api/internal/helpers/extract", { fields: FIELDS, file: "invoice.txt" }, { extract: answered });
    expect(text.extract.mock.calls[0]![2]).toEqual({ text: "Invoice INV-2291, total $1,080.00" });
    const image = await call("/api/internal/helpers/extract", { fields: FIELDS, file: join(work, "receipt.png") }, { extract: answered });
    expect(image.extract.mock.calls[0]![2]).toEqual({ images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] });
  });

  it.each([
    ["a file outside its folders", { file: join(elsewhere, "secret.txt") }, 400, "Only files in your working folder"],
    ["a path that escapes with ..", { file: "../elsewhere/secret.txt" }, 400, "Only files in your working folder"],
    ["a missing file", { file: "nope.txt" }, 400, "Nothing was found"],
    ["a PDF", { file: "scan.pdf" }, 400, "PDFs aren't read directly"],
    ["no text and no file", {}, 400, "give text or an image"],
    ["a bad field", { text: "x", fieldsOverride: { "due-date": { type: "date" } } }, 400, "field name"],
  ])("refuses %s, and the model is never asked", async (_name, extra, status, error) => {
    const { fieldsOverride, ...rest } = extra as Record<string, unknown>;
    const result = await call("/api/internal/helpers/extract", { fields: fieldsOverride ?? FIELDS, ...rest }, { extract: answered });
    expect(result.status).toBe(status);
    expect(result.payload?.error).toContain(error);
    expect(result.extract).not.toHaveBeenCalled();
  });

  it("other paths and methods pass through", async () => {
    expect((await call("/api/internal/x/search", {})).outcome).toBe(PASS);
  });
});

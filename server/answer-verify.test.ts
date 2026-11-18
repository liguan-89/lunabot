import { describe, expect, it } from "vitest";

import { criteriaFor, parseVerification, verifierRequest, verifyAnswer, type VerifyInput } from "./answer-verify.ts";

const input = (overrides: Partial<VerifyInput> = {}): VerifyInput => ({
  goal: "在微信里给阿明发「早上好」",
  criteria: criteriaFor("在微信里给阿明发「早上好」", true),
  answer: "已在微信里给阿明发送「早上好」。",
  evidence: [{ text: "微信\n阿明\n早上好\n已发送", where: "com.tencent.mm", kind: "read", step: 3 }],
  ...overrides,
});

const reply = (body: unknown) => JSON.stringify(body);

describe("criteriaFor", () => {
  it("falls back to the person's own words, with no second model call", () => {
    expect(criteriaFor("  在微信里发消息  ", false)).toEqual({ items: ["在微信里发消息"], kind: "read", fallback: true });
  });

  it("marks a send, submit, order, delete or pay as irreversible", () => {
    expect(criteriaFor("下单", true).kind).toBe("irreversible");
  });
});

describe("verifierRequest", () => {
  it("sends the checker's own instructions first and the material as one JSON object", () => {
    const [system, user] = verifierRequest(input());
    expect(system?.role).toBe("system");
    expect(String(system?.content)).toContain("cannot_verify");
    expect(user?.role).toBe("user");
    const text = String(user?.content);
    expect(text).toContain('"goal":"在微信里给阿明发「早上好」"');
    expect(text).toContain('"criteriaNote"');
    expect(text).toContain('"kind":"irreversible"');
    expect(text).toContain('"where":"com.tencent.mm"');
  });

  it("attaches screenshots as image parts after the text", () => {
    const [, user] = verifierRequest(input({ screenshots: [{ mimeType: "image/jpeg", data: "AAEC" }] }));
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAEC" } });
  });

  it("drops empty evidence and clips long text", () => {
    const [, user] = verifierRequest(input({ evidence: [{ text: "   " }, { text: "x".repeat(9_000) }] }));
    const text = String(user?.content);
    expect(text.match(/"text":"x+…"/u)).not.toBeNull();
    expect(text.split('"text"').length).toBe(2);
  });
});

describe("parseVerification", () => {
  it("reads a bare JSON object", () => {
    const parsed = parseVerification(reply({
      checks: [{ criterion: "发出去", status: "met", quote: "已发送" }], verdict: "pass", reason: "屏上显示已发送",
    }));
    expect(parsed).toEqual({
      verdict: "pass",
      checks: [{ criterion: "发出去", status: "met", quote: "已发送" }],
      reason: "屏上显示已发送",
      groundedBy: null,
      notFound: [],
    });
  });

  it("reads a fenced block and prose around it", () => {
    const raw = `Sure, here it is:\n\`\`\`json\n${reply({ verdict: "fail", checks: [{ criterion: "发出去", status: "unmet" }] })}\n\`\`\`\nDone.`;
    expect(parseVerification(raw)?.verdict).toBe("fail");
  });

  it("tolerates a brace inside a quoted string", () => {
    const raw = `Result: {"checks":[{"criterion":"the text {x}","status":"met","quote":"a } b"}],"verdict":"pass"}`;
    expect(parseVerification(raw)?.checks[0]).toEqual({ criterion: "the text {x}", status: "met", quote: "a } b" });
  });

  it("reads the alternative key names and the dashed verdict", () => {
    const parsed = parseVerification(reply({ conclusion: "cannot-verify", results: [{ item: "发出去", state: "UNKNOWN" }] }));
    expect(parsed?.verdict).toBe("cannot_verify");
    expect(parsed?.checks).toEqual([{ criterion: "发出去", status: "unknown", quote: null }]);
  });

  it("returns null when the verdict is missing or unknown", () => {
    expect(parseVerification("no json here")).toBeNull();
    expect(parseVerification(reply({ verdict: "maybe", checks: [] }))).toBeNull();
  });

  it("lets an unmet check override a pass, and an unknown one stop a pass", () => {
    expect(parseVerification(reply({ verdict: "pass", checks: [{ criterion: "a", status: "unmet" }] }))?.verdict).toBe("fail");
    expect(parseVerification(reply({ verdict: "pass", checks: [{ criterion: "a", status: "unknown" }] }))?.verdict).toBe("cannot_verify");
  });

  it("keeps a fail with an unknown check as a fail", () => {
    expect(parseVerification(reply({ verdict: "fail", checks: [{ criterion: "a", status: "unknown" }] }))?.verdict).toBe("fail");
  });
});

describe("verifyAnswer", () => {
  it("passes when the model passes and every fact is on the screen", async () => {
    const result = await verifyAnswer({ complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) }, input());
    expect(result.verdict).toBe("pass");
    expect(result.notFound).toEqual([]);
  });

  it("downgrades a pass whose facts grounding cannot find", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) },
      input({ answer: "已在微信里给阿明发送「晚上好」，余额 520 元。" }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.notFound).toEqual(["晚上好", "520"]);
    expect(result.reason).toContain("not on any screen");
  });

  it("keeps a fail as it came, without running grounding", async () => {
    let called = 0;
    const result = await verifyAnswer({
      complete: async () => {
        called++;
        return reply({ verdict: "fail", checks: [{ criterion: "发出去", status: "unmet" }], reason: "屏上没有已发送" });
      },
    }, input());
    expect(called).toBe(1);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("屏上没有已发送");
  });

  it("returns cannot_verify when nothing read supports a pass and there is no quotation", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "打开蓝牙", status: "met" }] }) },
      input({ answer: "已打开蓝牙。", evidence: [{ text: "蓝牙" }] }),
    );
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("no quoted screen text");
  });

  it("counts a picture for a pass with nothing in the text to compare", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "打开蓝牙", status: "met" }] }) },
      input({ answer: "已打开蓝牙。", evidence: [{ text: "蓝牙" }], screenshots: [{ mimeType: "image/jpeg", data: "AAEC" }] }),
    );
    expect(result.verdict).toBe("pass");
    expect(result.groundedBy).toBe("image");
  });

  it("lets a screenshot vouch for a screen state with no number in it", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) },
      input({
        answer: "消息「已发送」，屏上显示「已送达」。",
        screenshots: [{ mimeType: "image/jpeg", data: "AAEC" }],
      }),
    );
    expect(result.verdict).toBe("pass");
    expect(result.groundedBy).toBe("image");
    expect(result.notFound).toEqual(["已送达"]);
  });

  it("does not let a screenshot vouch for an answer with no support in the text", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) },
      input({ answer: "屏上显示「已送达」。", screenshots: [{ mimeType: "image/jpeg", data: "AAEC" }] }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.groundedBy).toBeNull();
  });

  it("does not let a screenshot vouch for a number", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) },
      input({ answer: "已发送 3 条，余额 520 元。", screenshots: [{ mimeType: "image/jpeg", data: "AAEC" }] }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.groundedBy).toBeNull();
  });

  it("leaves a pass alone when the bot read nothing at all", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "打个招呼", status: "met" }] }) },
      input({ answer: "你好！", evidence: [] }),
    );
    expect(result.verdict).toBe("pass");
  });

  it("does not trust a fail against the bare words of a follow-up", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "fail", checks: [{ criterion: "再发一条", status: "unmet" }] }) },
      input({ goal: "再发一条", earlierGoals: ["给阿明发「早上好」"] }),
    );
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("earlier turn");
  });

  it("names the missing reason on a fail that gave none", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "fail", checks: [{ criterion: "发出去", status: "unmet" }] }) },
      input(),
    );
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("named no criterion");
  });

  it("will not pass a check that skipped a criterion", async () => {
    const result = await verifyAnswer(
      { complete: async () => reply({ verdict: "pass", checks: [{ criterion: "发出去", status: "met", quote: "已发送" }] }) },
      input({ criteria: { items: ["发出去", "对方收到"], kind: "irreversible", fallback: false } }),
    );
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("every criterion");
  });

  it("returns cannot_verify when the model times out", async () => {
    const result = await verifyAnswer({ complete: () => new Promise<string>(() => {}), timeoutMs: 10 }, input());
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("in time");
  });

  it("returns cannot_verify when the model call fails", async () => {
    const result = await verifyAnswer({ complete: async () => { throw new Error("upstream 500"); } }, input());
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("could not be reached");
  });

  it("returns cannot_verify when the reply cannot be parsed", async () => {
    const result = await verifyAnswer({ complete: async () => "I think it went fine." }, input());
    expect(result.verdict).toBe("cannot_verify");
    expect(result.reason).toContain("could not be read");
  });

  it("returns cannot_verify for an empty answer", async () => {
    const result = await verifyAnswer({ complete: async () => { throw new Error("should not be called"); } }, input({ answer: "   " }));
    expect(result.verdict).toBe("cannot_verify");
  });

  it("never throws, whatever the model does", async () => {
    const odd = [async () => "", async () => "{", async () => "null", async () => "```json\n{}\n```"];
    for (const complete of odd) {
      await expect(verifyAnswer({ complete }, input())).resolves.toMatchObject({ verdict: "cannot_verify" });
    }
  });

  it("never throws when the model call throws before returning a promise", async () => {
    const throwing = (() => { throw new Error("sync boom"); }) as unknown as () => Promise<string>;
    await expect(verifyAnswer({ complete: throwing }, input())).resolves.toMatchObject({ verdict: "cannot_verify" });
  });
});

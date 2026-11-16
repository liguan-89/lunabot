import { describe, expect, it, vi } from "vitest";
import { LAYA_MODEL_REVISION, layaBackend, layaEndpoint, layaRequestBody, localLayaSupported, createLocalLaya } from "./local-laya.ts";
import type { BackendRequest, DeciderQuestion } from "./types.ts";

const questions: Record<string, DeciderQuestion> = {
  route: { type: "choice", instructions: "Choose a fruit.", options: { apple: "Apple", pear: "Pear" } },
  level: { type: "score", instructions: "Score the match.", levels: ["low", "medium", "high"] },
  fruit: { type: "yesno", instructions: "Is this a fruit?", criteria: { yes: "It is a fruit.", no: "It is not a fruit." } },
};
const answer = {
  answers: {
    route: { type: "choice", choice: "apple", probabilities: { apple: 0.9, pear: 0.1 } },
    level: { type: "score", score: 1.8, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 } },
    fruit: { type: "noul", noul: 0.99 },
  },
};
function request(fetchImpl: typeof fetch, extra: Partial<BackendRequest> = {}): BackendRequest {
  return {
    key: "local-secret-token",
    baseUrl: "http://127.0.0.1:8173",
    state: { input: "apple" },
    questions,
    signal: new AbortController().signal,
    fetch: fetchImpl,
    ...extra,
  };
}

describe("local Laya decision backend", () => {
  it("pins the publicly resolvable CPU+GPU model revision", () => {
    expect(LAYA_MODEL_REVISION).toBe("8139e9089273319512c730218903784074133187");
  });

  it("supports only Apple Silicon macOS and accepts only unauthenticated loopback HTTP roots", () => {
    expect(localLayaSupported("darwin", "arm64")).toBe(true);
    expect(localLayaSupported("darwin", "x64")).toBe(false);
    expect(localLayaSupported("linux", "arm64")).toBe(false);
    expect(String(layaEndpoint("http://127.0.0.1:8173/"))).toBe("http://127.0.0.1:8173/v1/systemone");
    expect(String(layaEndpoint("http://[::1]:8173"))).toBe("http://[::1]:8173/v1/systemone");
    for (const url of ["https://127.0.0.1:8173", "http://192.0.2.1:8173", "http://user:pass@127.0.0.1:8173", "file:///tmp/model"]) {
      expect(layaEndpoint(url)).toBeNull();
    }
  });

  it("defaults service platform detection to the running host and still respects explicit disables", () => {
    const enabled = createLocalLaya({ dataDir: "/tmp/local-laya-test", projectDir: "/tmp/laya-service" });
    const disabled = createLocalLaya({ dataDir: "/tmp/local-laya-test", projectDir: "/tmp/laya-service", platform: "linux", arch: "arm64" });
    expect(enabled.supported).toBe(localLayaSupported());
    expect(disabled.supported).toBe(false);
  });

  it("uses the Jev-compatible request body for all decision question types", () => {
    expect(layaRequestBody({ input: "apple" }, questions)).toEqual({
      state: { input: "apple" }, model: "jev-latest", questions: {
        route: { type: "choice", instructions: "Choose a fruit.", criteria: { apple: "Apple", pear: "Pear" } },
        level: { type: "score", instructions: "Score the match.", criteria: ["low", "medium", "high"] },
        fruit: { type: "noul", instructions: "Is this a fruit?", criteria: { true: "It is a fruit.", false: "It is not a fruit." } },
      },
    });
  });

  it("validates returned probabilities and refuses redirects without forwarding the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }));
    await expect(layaBackend.decide(request(fetchImpl))).resolves.toMatchObject({ ok: true, answers: { route: { choice: "apple" }, fruit: { p: 0.99 } } });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("http://127.0.0.1:8173/v1/systemone"), expect.objectContaining({
      method: "POST", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer local-secret-token" }),
    }));

    const redirect = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("redirect blocked"));
    await expect(layaBackend.decide(request(redirect))).resolves.toEqual({ ok: false, reason: "unreachable" });
    expect(redirect).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: { ...answer.answers, route: { type: "choice", choice: "pear", probabilities: { apple: 0.9, pear: 0.1 } } } }), { status: 200 }));
    await expect(layaBackend.decide(request(malformed))).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("does not call a configured non-loopback endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(layaBackend.decide(request(fetchImpl, { baseUrl: "http://example.com" }))).resolves.toEqual({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { generateSeedanceStateVideo, resolveSeedanceTarget } from "./seedance.ts";

describe("seedance target resolution & generation", () => {
  it("resolves Volcengine Ark official target with 720p default", () => {
    const target = resolveSeedanceTarget({ provider: "ark", arkKey: "ark-secret" });
    expect(target.provider).toBe("ark");
    expect(target.createUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(target.resolution).toBe("720p");
    expect(target.apiKey).toBe("ark-secret");
  });

  it("normalizes TK1688 /v1/videos relay host, /v1, or full path", () => {
    const tDefault = resolveSeedanceTarget({ provider: "tk1688", tk1688Key: "tk-key" });
    expect(tDefault.createUrl.endsWith("/v1/videos")).toBe(true);
    expect(tDefault.model).toBe("doubao-seedance-2-5-260628-sec-720p");
    expect(tDefault.resolution).toBe("720p");

    const t1 = resolveSeedanceTarget({
      provider: "tk1688",
      tk1688Key: "tk-key",
      tk1688Endpoint: "https://relay.example.test",
    });
    expect(t1.createUrl).toBe("https://relay.example.test/v1/videos");
    expect(t1.resolution).toBe("720p");

    const t2 = resolveSeedanceTarget({
      provider: "tk1688",
      tk1688Key: "tk-key",
      tk1688Endpoint: "https://relay.example.test/v1/videos",
      resolution: "480p",
    });
    expect(t2.createUrl).toBe("https://relay.example.test/v1/videos");
    expect(t2.resolution).toBe("480p");
  });

  it("throws 409 when API key is missing", () => {
    expect(() => resolveSeedanceTarget({ provider: "tk1688" })).toThrow();
    expect(() => resolveSeedanceTarget({ provider: "ark" })).toThrow();
  });

  it("creates, polls, and downloads a seamless-loop 720p state video", async () => {
    const fakeMp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cgt-123" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "cgt-123", status: "running" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "cgt-123",
        status: "succeeded",
        content: { video_url: "https://cdn.example.test/loop.mp4" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(fakeMp4, { status: 200, headers: { "content-type": "video/mp4" } }));

    const result = await generateSeedanceStateVideo(
      { provider: "ark", arkKey: "ark-test-key" },
      {
        state: "working",
        seamlessLoop: true,
        referenceImageDataUrl: "data:image/png;base64,AAAA",
        fetchImpl: fetchMock,
        pollIntervalMs: 1,
        maxWaitMs: 5_000,
      },
    );

    expect(result.taskId).toBe("cgt-123");
    expect(result.mime).toBe("video/mp4");
    expect(result.bytes.byteLength).toBe(fakeMp4.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody.resolution).toBe("720p");
    expect(createBody.content.some((c: { role?: string }) => c.role === "first_frame")).toBe(true);
    expect(createBody.content.some((c: { role?: string }) => c.role === "last_frame")).toBe(true);
  });

  it("sends the same Bearer key when downloading a TK1688 video_url", async () => {
    const fakeMp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "task_abc" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "task_abc",
        status: "completed",
        url: "https://relay.example.test/v1/videos/task_abc/content",
      }), { status: 200 }))
      .mockImplementationOnce(async (_url, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer demo-key-123") return new Response("unauthorized", { status: 401 });
        return new Response(fakeMp4, { status: 200, headers: { "content-type": "video/mp4" } });
      });

    const result = await generateSeedanceStateVideo(
      { provider: "tk1688", tk1688Endpoint: "https://relay.example.test/v1", tk1688Key: "demo-key-123" },
      { state: "idle", fetchImpl: fetchMock, pollIntervalMs: 1, maxWaitMs: 5_000 },
    );

    expect(result.taskId).toBe("task_abc");
    expect(result.bytes.byteLength).toBe(fakeMp4.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../state/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../state/api")>();
  return { ...original, api: vi.fn() };
});

import { api, ApiError } from "../state/api";
import { apiWithPresence } from "./presence";

const apiMock = vi.mocked(api);

function refusal(options: Record<string, unknown>) {
  return new ApiError("Confirm on this device to allow", 403, { error: "Confirm on this device to allow", presence: { options } });
}

describe("apiWithPresence", () => {
  beforeEach(() => {
    apiMock.mockReset();
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it("passes through a clean answer untouched", async () => {
    apiMock.mockResolvedValue({ ok: true });
    expect(await apiWithPresence("/api/threads/t1/respond", { requestId: "r1", behavior: "allow" })).toEqual({ ok: true });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows a refusal that carries no presence options", async () => {
    apiMock.mockRejectedValue(new ApiError("nope", 403, { error: "nope" }));
    await expect(apiWithPresence("/api/threads/t1/respond", { requestId: "r1", behavior: "allow" })).rejects.toThrow("nope");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("runs the authenticator and resends with the assertion on a presence refusal", async () => {
    apiMock.mockRejectedValueOnce(refusal({ challenge: "Y2hhbGxlbmdl", allowCredentials: [{ type: "public-key", id: "Y3JlZA" }] }));
    apiMock.mockResolvedValueOnce({ ok: true });
    const rawId = new Uint8Array([1, 2, 3]).buffer;
    const authenticatorData = new Uint8Array([4, 5]).buffer;
    const clientDataJSON = new Uint8Array([6, 7]).buffer;
    const signature = new Uint8Array([8, 9]).buffer;
    const get = vi.fn().mockResolvedValue({ rawId, response: { authenticatorData, clientDataJSON, signature } });
    Object.defineProperty(globalThis, "navigator", { value: { credentials: { get } }, configurable: true });
    expect(await apiWithPresence("/api/threads/t1/respond", { requestId: "r1", behavior: "allow" })).toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(1);
    const request = get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(Array.from(new Uint8Array(request.challenge as ArrayBuffer))).toEqual([99, 104, 97, 108, 108, 101, 110, 103, 101]);
    expect(request.userVerification).toBe("required");
    const resent = JSON.parse(apiMock.mock.calls[1][1]?.body as string);
    expect(resent.behavior).toBe("allow");
    expect(resent.webauthn.credentialId).toBe("AQID");
    expect(resent.webauthn.signature).toBe("CAk");
  });

  it("surfaces a cancelled ceremony instead of retrying", async () => {
    apiMock.mockRejectedValue(refusal({ challenge: "Y2g" }));
    Object.defineProperty(globalThis, "navigator", { value: { credentials: { get: vi.fn().mockRejectedValue(new DOMException("cancelled", "NotAllowedError")) } }, configurable: true });
    await expect(apiWithPresence("/api/threads/t1/respond", { requestId: "r1", behavior: "allow" })).rejects.toThrow("cancelled");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

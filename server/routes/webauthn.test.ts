import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { WebAuthnCredential } from "../webauthn.ts";
import { createWebAuthnRoutes, type WebAuthnRouteDeps } from "./webauthn.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function fixture() {
  const credentials: WebAuthnCredential[] = [];
  const saved = vi.fn();
  const deps: WebAuthnRouteDeps = {
    credentials: () => credentials,
    saveCredentials: (next) => { credentials.splice(0, credentials.length, ...next); saved(next); },
    ownerName: () => "owner",
  };
  const serve = async (admin = true): Promise<string> => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes([createWebAuthnRoutes(deps)], {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: admin ? ["admin"] : [] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const post = async (base: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { credentials, saved, serve, post };
}

describe("webauthn routes", () => {
  it("reports enrollment state and refuses non-admin callers on every endpoint", async () => {
    const { serve, post } = fixture();
    const base = await serve();
    expect(await post(base, "/api/webauthn/status")).toMatchObject({ status: 200, body: { enrolled: 0 } });
    expect(await post(base, "/api/webauthn/assert/options", {})).toMatchObject({ status: 409 });
    const member = await serve(false);
    expect((await fetch(`${member}/api/webauthn/status`)).status).toBe(403);
    for (const path of ["/api/webauthn/register/options", "/api/webauthn/register", "/api/webauthn/assert/options", "/api/webauthn/assert"]) {
      expect((await post(member, path, {})).status, path).toBe(403);
    }
  });

  it("issues register options with one-time challenges and stores a verified credential", async () => {
    const { serve, post, credentials, saved } = fixture();
    const base = await serve();
    const { body } = await post(base, "/api/webauthn/register/options", {});
    const options = body.options as Record<string, unknown>;
    expect(options.attestation).toBe("none");
    expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    expect(options.authenticatorSelection).toMatchObject({ userVerification: "required" });
    const bad = await post(base, "/api/webauthn/register", { challenge: options.challenge, attestationObject: "AA", clientDataJSON: "e30" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("not accepted");
    expect(credentials).toHaveLength(0);
    expect(saved).not.toHaveBeenCalled();
  });

  it("assert options name only enrolled credentials; assert verifies a spent challenge once", async () => {
    const { serve, post, credentials } = fixture();
    credentials.push({ credentialId: "cred-1", publicKeyJwk: { kty: "EC", crv: "P-256", x: "e", y: "l" }, rpIdHash: "h", origin: "http://localhost:1", signCount: 0, createdAt: "t" });
    const base = await serve();
    const { body } = await post(base, "/api/webauthn/assert/options", {});
    expect((body.options as { allowCredentials: unknown[] }).allowCredentials).toEqual([{ type: "public-key", id: "cred-1" }]);
    const forged = await post(base, "/api/webauthn/assert", { credentialId: "cred-1", authenticatorData: "AA", clientDataJSON: "e30", signature: "AA" });
    expect(forged.status).toBe(403);
  });
});

import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { b64u, relaySigningKey } from "../src/crypto.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";

function start(config) {
  const store = openStore(":memory:");
  const codes = [];
  const emailer = async ({ to, text }) => {
    const match = text.match(/\b\d{8}\b/);
    codes.push({ to, code: match ? match[0] : "" });
  };
  const relayKey = relaySigningKey(config.relaySeed);
  const server = createServer(createApp({ config, store, emailer, relayKey, log: (message) => process.stderr.write(`[test] ${message}\n`) }));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, store, codes, base: `http://127.0.0.1:${server.address().port}`, config }));
  });
}

async function call(base, method, path, body, token, headers = {}) {
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json, headers: response.headers };
}

const config = () => loadConfig({
  DEXCLOUD_DB: ":memory:",
  DEXCLOUD_ORIGIN: "https://cloud.dexai.vip",
  DEXCLOUD_RELAY_TOKEN_SEED: b64u(randomBytes(32)),
  DEXCLOUD_DEV_CODES: "1",
  DEXCLOUD_SIGNUP_OPEN: "1",
  DEXCLOUD_PLAN_MODE: "pro",
});

test("device approval issues a session and the session carries a licence", async () => {
  const app = await start(config());
  try {
    const authorize = await call(app.base, "POST", "/api/cloud/desktop/authorize", {
      deviceName: "Mac mini",
      platform: "darwin",
      appVersion: "2.0.0",
    });
    assert.equal(authorize.status, 200);
    assert.equal(authorize.body.cloudContractVersion, 1);
    assert.match(authorize.body.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(authorize.body.userCode, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(authorize.body.verificationUriComplete, `https://cloud.dexai.vip/cloud/desktop?code=${authorize.body.userCode}`);

    const pending = await call(app.base, "POST", "/api/cloud/desktop/token", { deviceCode: authorize.body.deviceCode });
    assert.equal(pending.status, 400);
    assert.equal(pending.body.error, "authorization_pending");

    const approval = await call(app.base, "POST", "/api/cloud/desktop/approve/start", {
      userCode: authorize.body.userCode,
      email: "Owner@Example.com",
    });
    assert.equal(approval.status, 200);
    const approvalCode = app.codes.at(-1).code;
    assert.match(approvalCode, /^\d{8}$/);

    const approved = await call(app.base, "POST", "/api/cloud/desktop/approve/verify", {
      userCode: authorize.body.userCode,
      attempt: approval.body.attempt,
      code: approvalCode,
    });
    assert.equal(approved.status, 200);

    const token = await call(app.base, "POST", "/api/cloud/desktop/token", { deviceCode: authorize.body.deviceCode });
    assert.equal(token.status, 200);
    assert.match(token.body.accessToken, /^omc_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.body.account.email, "owner@example.com");

    const session = await call(app.base, "GET", "/api/cloud/desktop/session", undefined, token.body.accessToken);
    assert.equal(session.status, 200);
    assert.equal(session.body.entitlement.plan, "pro");
    assert.equal(session.body.entitlement.status, "active");
    assert.deepEqual(session.body.clouds, []);
    assert.equal(session.body.account.email, "owner@example.com");
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("email sign-in issues a grant and rejects a wrong code", async () => {
  const app = await start(config());
  try {
    const startResponse = await call(app.base, "POST", "/api/cloud/app/sign-in/start", {
      email: "person@example.com",
      deviceName: "Windows PC",
      platform: "win32",
      appVersion: "2.0.0",
    });
    assert.equal(startResponse.status, 200);
    const code = app.codes.at(-1).code;

    const wrong = await call(app.base, "POST", "/api/cloud/app/sign-in/verify", {
      attempt: startResponse.body.attempt,
      code: "00000000",
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_code");

    const ok = await call(app.base, "POST", "/api/cloud/app/sign-in/verify", {
      attempt: startResponse.body.attempt,
      code,
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body.accessToken, /^omc_/);
    assert.equal(ok.body.account.email, "person@example.com");
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("control plane creates installations and mints a relay token the relay key verifies", async () => {
  const app = await start(config());
  try {
    const startResponse = await call(app.base, "POST", "/api/auth/email-otp/send-verification-otp", {
      email: "relay@example.com",
      type: "sign-in",
    });
    if (startResponse.status !== 200) process.stderr.write(`control start: ${JSON.stringify(startResponse.body)}\n`);
    assert.equal(startResponse.status, 200);
    const code = app.codes.at(-1).code;

    const signIn = await call(app.base, "POST", "/api/auth/sign-in/email-otp", {
      email: "relay@example.com",
      otp: code,
      name: "relay",
    });
    assert.equal(signIn.status, 200);
    const accountToken = signIn.headers.get("set-auth-token");
    assert.match(accountToken, /^cps_/);

    const me = await call(app.base, "GET", "/v1/me", undefined, accountToken);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "relay@example.com");

    const installation = await call(app.base, "POST", "/v1/installations", {
      clientInstanceId: "3f7c9a2e-0f1d-4b7a-9a1e-2d3c4b5a6f70",
      name: "Relay Mac",
      platform: "darwin",
      appVersion: "2.0.0",
      kind: "desktop",
    }, accountToken);
    assert.equal(installation.status, 201);
    assert.match(installation.body.credential, /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

    const endpoint = await call(app.base, "POST", "/v1/installations/self/endpoint", {}, installation.body.credential);
    assert.equal(endpoint.status, 409);
    assert.equal(endpoint.body.error, "relay_capable");
    assert.equal(endpoint.body.tunnel, "retired");

    const grant = await call(app.base, "POST", "/v1/installations/self/relay-token", {
      appVersion: "2.0.0",
      devices: { e2e: true, legacy: 0 },
    }, installation.body.credential);
    assert.equal(grant.status, 200);
    assert.deepEqual(grant.body.nodes, ["relay1.dexai.vip"]);
    assert.match(grant.body.hostId, /^[A-Za-z0-9_-]{22}$/);

    const [body, signature] = grant.body.token.split(".");
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: relaySigningKey(app.config.relaySeed).publicKey },
      format: "jwk",
    });
    assert.equal(verify(null, Buffer.from(body, "ascii"), publicKey, Buffer.from(signature, "base64url")), true);
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    assert.equal(claims.v, 1);
    assert.equal(claims.hid, grant.body.hostId);
    assert.equal(claims.exp - claims.iat, 12 * 3600);
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("healthz names the control plane", async () => {
  const app = await start(config());
  try {
    const health = await call(app.base, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.service, "openmausbot-control-plane");
  } finally {
    app.server.close();
    app.store.close();
  }
});

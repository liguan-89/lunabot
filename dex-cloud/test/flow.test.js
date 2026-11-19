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

    // A second token keeps the same identity: a paired phone pins the
    // descriptor's `h` and keeps dialling it, so a fresh one would leave it at
    // the relay's 4404 while both ends are online.
    const renewed = await call(app.base, "POST", "/v1/installations/self/relay-token", {
      appVersion: "2.0.0",
      devices: { e2e: true, legacy: 0 },
    }, installation.body.credential);
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.hostId, grant.body.hostId);
    const renewedClaims = JSON.parse(Buffer.from(renewed.body.token.split(".")[0], "base64url").toString("utf8"));
    assert.equal(renewedClaims.hid, grant.body.hostId);
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

test("the Cloud serves docs, feedback and the download page instead of a private repository", async () => {
  const app = await start(config());
  try {
    const docs = await call(app.base, "GET", "/docs");
    assert.equal(docs.status, 200);
    assert.match(String(docs.body), /疑难解答/);
    assert.match(String(docs.body), /id="permissions"/);
    assert.match(String(docs.body), /id="self-hosting"/);
    assert.equal((await call(app.base, "GET", "/help")).status, 200);
    assert.equal((await call(app.base, "GET", "/docs/troubleshooting")).status, 200);
    assert.equal((await call(app.base, "GET", "/feedback")).status, 200);
    assert.equal((await call(app.base, "GET", "/issues")).status, 200);
    const download = await call(app.base, "GET", "/download");
    assert.equal(download.status, 200);
    assert.match(String(download.body), /\/download\/dexbot\.apk/);
    assert.match(String(download.body), /com\.lunabot\.companion/);
    assert.doesNotMatch(String(download.body), /com\.dexbot\.companion/);
    assert.doesNotMatch(String(download.body), /github\.com\/liguan-89/);
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("a bug report is stored, answered with 201, and its status is scoped to the install that sent it", async () => {
  const app = await start(config());
  try {
    const sent = await call(app.base, "POST", "/api/bug-reports", {
      installId: "install-abc123",
      source: "bot",
      description: "@devs the calendar never syncs",
      appVersion: "2.0.0",
      platform: "darwin",
      diagnostics: "## Server warnings\nnone",
    });
    assert.equal(sent.status, 201);
    assert.match(sent.body.id, /^[A-Za-z0-9_-]{1,64}$/);

    const status = await call(app.base, "POST", "/api/bug-reports/status", { installId: "install-abc123", ids: [sent.body.id, "br_missing"] });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.reports, [
      { id: sent.body.id, status: "received", fixedIn: null },
      { id: "br_missing", status: "unknown", fixedIn: null },
    ]);
    assert.equal(status.body.notify, true);

    const other = await call(app.base, "POST", "/api/bug-reports/status", { installId: "install-other", ids: [sent.body.id] });
    assert.equal(other.body.reports[0].status, "unknown");

    const invalid = await call(app.base, "POST", "/api/bug-reports", { installId: "bad id", description: "x" });
    assert.equal(invalid.status, 400);
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("an admin reads reports and marks one fixed, which the sender then sees", async () => {
  const app = await start(loadConfig({
    DEXCLOUD_DB: ":memory:",
    DEXCLOUD_ORIGIN: "https://cloud.dexai.vip",
    DEXCLOUD_RELAY_TOKEN_SEED: b64u(randomBytes(32)),
    DEXCLOUD_DEV_CODES: "1",
    DEXCLOUD_PLAN_MODE: "pro",
    DEXCLOUD_ADMIN_EMAILS: "admin@example.com",
  }));
  try {
    const authorize = await call(app.base, "POST", "/api/cloud/desktop/authorize", { deviceName: "Admin Mac", platform: "darwin", appVersion: "2.0.0" });
    const approval = await call(app.base, "POST", "/api/cloud/desktop/approve/start", { userCode: authorize.body.userCode, email: "admin@example.com" });
    await call(app.base, "POST", "/api/cloud/desktop/approve/verify", { userCode: authorize.body.userCode, attempt: approval.body.attempt, code: app.codes.at(-1).code });
    const token = await call(app.base, "POST", "/api/cloud/desktop/token", { deviceCode: authorize.body.deviceCode });
    assert.equal(token.status, 200);

    const sent = await call(app.base, "POST", "/api/bug-reports", { installId: "install-abc123", source: "web", description: "something broke" });
    assert.equal(sent.status, 201);

    const list = await call(app.base, "GET", "/api/cloud/desktop/admin/bug-reports", undefined, token.body.accessToken);
    assert.equal(list.status, 200);
    assert.equal(list.body.reports[0].id, sent.body.id);

    const fixed = await call(app.base, "POST", `/api/cloud/desktop/admin/bug-reports/${sent.body.id}/fixed`, { fixedIn: "2.0.1" }, token.body.accessToken);
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.status, "fixed");

    const status = await call(app.base, "POST", "/api/bug-reports/status", { installId: "install-abc123", ids: [sent.body.id] });
    assert.deepEqual(status.body.reports[0], { id: sent.body.id, status: "fixed", fixedIn: "2.0.1" });
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("the defaults name Luna Bot's own image and update manifest", async () => {
  const defaults = config();
  assert.equal(defaults.cloudImage, "lunabot-cloud-home:local");
  const overridden = loadConfig({
    DEXCLOUD_ORIGIN: "https://cloud.dexai.vip",
    DEXCLOUD_RELAY_TOKEN_SEED: b64u(randomBytes(32)),
    DEXCLOUD_CLOUD_IMAGE: "example.invalid/cloud-home:test",
    DEXCLOUD_LATEST_VERSION: "9.8.7",
  });
  assert.equal(overridden.cloudImage, "example.invalid/cloud-home:test");

  const app = await start(overridden);
  try {
    const manifest = await call(app.base, "GET", "/update.json");
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.versionName, "9.8.7");
    assert.match(String(manifest.body.notes), /^Luna Bot 9\.8\.7 · /);
    assert.doesNotMatch(String(manifest.body.notes), /DEX BOT/);
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("the bundled OG card is served at /og.png", async () => {
  const app = await start(config());
  try {
    const response = await fetch(`${app.base}/og.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    assert.ok(body.length > 1000);
    assert.deepEqual(Array.from(body.slice(1, 4)), [0x50, 0x4e, 0x47]);
    const missing = await fetch(`${app.base}/og.png`, { method: "HEAD" });
    assert.equal(missing.status, 200);
  } finally {
    app.server.close();
    app.store.close();
  }
});

test("a signed-in phone asks a computer to connect and the computer answers with a pairing link", async () => {
  const app = await start(config());
  try {
    const signIn = await call(app.base, "POST", "/api/auth/email-otp/send-verification-otp", {
      email: "owner@example.com",
      type: "sign-in",
    });
    assert.equal(signIn.status, 200);
    const verify = await call(app.base, "POST", "/api/auth/sign-in/email-otp", {
      email: "owner@example.com",
      otp: app.codes.at(-1).code,
      name: "owner",
    });
    assert.equal(verify.status, 200);
    const accountToken = verify.headers.get("set-auth-token");

    const created = await call(app.base, "POST", "/v1/installations", {
      clientInstanceId: "9d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
      name: "Studio Mac",
      platform: "darwin",
      appVersion: "2.1.0",
      kind: "desktop",
    }, accountToken);
    assert.equal(created.status, 201);
    const installationId = created.body.installation.id;
    const credential = created.body.credential;

    const listed = await call(app.base, "GET", "/v1/installations", undefined, accountToken);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.installations[0].name, "Studio Mac");
    assert.equal(listed.body.installations[0].online, true);
    // The phone tells a computer it can ask from one it cannot by `kind`: the
    // account lists every installation, the phone's own included.
    assert.equal(listed.body.installations[0].kind, "desktop");
    assert.equal(listed.body.installations[0].clientInstanceId, "9d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b");

    const asked = await call(app.base, "POST", `/v1/installations/${installationId}/pair-requests`, { deviceName: "OnePlus 15T" }, accountToken);
    assert.equal(asked.status, 201);
    const requestId = asked.body.requestId;
    assert.match(requestId, /^[0-9a-f-]{36}$/);

    const waiting = await call(app.base, "GET", "/v1/installations/self/pair-requests", undefined, credential);
    assert.equal(waiting.status, 200);
    assert.equal(waiting.body.requests.length, 1);
    assert.equal(waiting.body.requests[0].deviceName, "OnePlus 15T");

    const stillPending = await call(app.base, "GET", `/v1/installations/${installationId}/pair-requests/${requestId}`, undefined, accountToken);
    assert.equal(stillPending.status, 200);
    assert.equal(stillPending.body.status, "pending");
    assert.equal(stillPending.body.link, undefined);

    const link = "lunabot://pair?address=192.168.10.120%3A8810&token=omb_pair_example";
    const allowed = await call(app.base, "POST", `/v1/installations/self/pair-requests/${requestId}`, { decision: "allow", link }, credential);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, "allowed");

    const answered = await call(app.base, "GET", `/v1/installations/${installationId}/pair-requests/${requestId}`, undefined, accountToken);
    assert.equal(answered.status, 200);
    assert.equal(answered.body.status, "allowed");
    assert.equal(answered.body.link, link);

    // A second answer cannot rewrite an already-answered request.
    const again = await call(app.base, "POST", `/v1/installations/self/pair-requests/${requestId}`, { decision: "deny" }, credential);
    assert.equal(again.status, 409);

    // Another account neither sees the computer nor its request.
    await call(app.base, "POST", "/api/auth/email-otp/send-verification-otp", { email: "stranger@example.com", type: "sign-in" });
    const strangerVerify = await call(app.base, "POST", "/api/auth/sign-in/email-otp", {
      email: "stranger@example.com",
      otp: app.codes.at(-1).code,
      name: "stranger",
    });
    const strangerToken = strangerVerify.headers.get("set-auth-token");
    const peek = await call(app.base, "GET", `/v1/installations/${installationId}/pair-requests/${requestId}`, undefined, strangerToken);
    assert.equal(peek.status, 404);
    const askForeign = await call(app.base, "POST", `/v1/installations/${installationId}/pair-requests`, { deviceName: "x" }, strangerToken);
    assert.equal(askForeign.status, 404);

    // A decline is terminal and carries no link.
    const denied = await call(app.base, "POST", `/v1/installations/${installationId}/pair-requests`, { deviceName: "Old phone" }, accountToken);
    await call(app.base, "POST", `/v1/installations/self/pair-requests/${denied.body.requestId}`, { decision: "deny" }, credential);
    const denial = await call(app.base, "GET", `/v1/installations/${installationId}/pair-requests/${denied.body.requestId}`, undefined, accountToken);
    assert.equal(denial.body.status, "denied");
    assert.equal(denial.body.link, undefined);
  } finally {
    app.server.close();
    app.store.close();
  }
});

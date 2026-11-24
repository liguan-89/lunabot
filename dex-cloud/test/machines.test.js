import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { b64u, relaySigningKey, sha256Hex } from "../src/crypto.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";

function start(env = {}) {
  const store = openStore(":memory:");
  const pagesDir = mkdtempSync(join(tmpdir(), "dex-pages-"));
  const config = loadConfig({
    DEXCLOUD_DB: ":memory:",
    DEXCLOUD_ORIGIN: "https://cloud.dexai.vip",
    DEXCLOUD_RELAY_TOKEN_SEED: b64u(randomBytes(32)),
    DEXCLOUD_DEV_CODES: "1",
    DEXCLOUD_LATEST_VERSION: "2.1.6",
    DEXCLOUD_PAGES_DIR: pagesDir,
    ...env,
  });
  const server = createServer(createApp({
    config, store,
    emailer: async () => {},
    relayKey: relaySigningKey(config.relaySeed),
    log: () => {},
  }));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, store, config, pagesDir, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function accountSession(store, email = "owner@example.com") {
  const account = store.insertAccount({ id: `acct_${randomBytes(8).toString("hex")}`, email, planTier: "max", planStatus: "active", planExpiresAt: null });
  const device = store.insertDevice({ id: `dev_${randomBytes(8).toString("hex")}`, accountId: account.id, name: "Mac", platform: "darwin", appVersion: "2.1.6" });
  const token = `omc_${b64u(randomBytes(32))}`;
  store.insertSession({ id: randomBytes(16).toString("hex"), accountId: account.id, deviceId: device.id, tokenHash: sha256Hex(token), expiresAt: Date.now() + 60_000 });
  return { account, token };
}

function homeCloud(store, accountId) {
  const secret = b64u(randomBytes(32));
  const cloud = store.insertCloud({
    id: `c-${randomBytes(6).toString("hex")}`, accountId, name: "My Cloud", status: "ready", role: "owner",
    hostname: "c-abc123.cloud.dexai.vip", machineId: `c-${randomBytes(6).toString("hex")}`, bootstrapSecret: secret,
  });
  store.updateCloud(cloud.id, { power_state: "asleep" });
  return { cloud: store.cloud(cloud.id), secret };
}

function homeHeaders(secret, machineId, body, prefix, hash = "base64url", timestamp = String(Math.floor(Date.now() / 1000))) {
  const nonce = randomBytes(18).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest(hash);
  const signature = `v1=${createHmac("sha256", secret).update(`${prefix}\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url")}`;
  return { "x-lunabot-cloud-machine": machineId, "x-lunabot-cloud-timestamp": timestamp, "x-lunabot-cloud-nonce": nonce, "x-lunabot-cloud-signature": signature };
}

async function call(base, method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json, headers: response.headers };
}

function multipart(manifest, files) {
  const boundary = "----lunabottestboundary";
  const chunks = [Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n`)];
  files.forEach((data, index) => {
    chunks.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="f${index}"\r\n\r\n`), data, Buffer.from("\r\n"));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("machines/woke flips power_state and records the version", async () => {
  const app = await start();
  try {
    const { account } = accountSession(app.store);
    const { cloud, secret } = homeCloud(app.store, account.id);
    const body = JSON.stringify({ v: 1, wokeAt: Date.now(), version: "2.1.7" });
    const response = await call(app.base, "POST", "/api/cloud/machines/woke", body,
      homeHeaders(secret, cloud.machine_id, body, "omb-power-woke-v1", "hex"));
    assert.equal(response.status, 200);
    const after = app.store.cloud(cloud.id);
    assert.equal(after.power_state, "awake");
    assert.equal(after.version, "2.1.7");
    assert.ok(Number(after.last_seen_at) > 0);
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

test("machines/woke rejects a wrong secret and a stale timestamp", async () => {
  const app = await start();
  try {
    const { account } = accountSession(app.store);
    const { cloud, secret } = homeCloud(app.store, account.id);
    const body = JSON.stringify({ v: 1, wokeAt: Date.now() });
    const bad = await call(app.base, "POST", "/api/cloud/machines/woke", body,
      homeHeaders("wrong-secret", cloud.machine_id, body, "omb-power-woke-v1", "hex"));
    assert.equal(bad.status, 401);
    const stale = await call(app.base, "POST", "/api/cloud/machines/woke", body,
      homeHeaders(secret, cloud.machine_id, body, "omb-power-woke-v1", "hex", String(Math.floor(Date.now() / 1000) - 3600)));
    assert.equal(stale.status, 401);
    assert.equal(app.store.cloud(cloud.id).power_state, "asleep");
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

test("included pages: desktop token → mint → upload → public GET → delete", async () => {
  const app = await start();
  try {
    const { token } = accountSession(app.store);

    const access = await call(app.base, "POST", "/api/cloud/desktop/services/pages", {}, { authorization: `Bearer ${token}` });
    assert.equal(access.status, 200);
    assert.equal(access.body.cloudContractVersion, 1);
    assert.match(access.body.token, /^omb_pd_[A-Za-z0-9_-]{43}$/);
    assert.equal(access.body.url, "https://cloud.dexai.vip/api/cloud/pages/token");

    const mint = await call(app.base, "POST", "/api/cloud/pages/token", { action: "create" }, { authorization: `Bearer ${access.body.token}` });
    assert.equal(mint.status, 200);
    assert.match(mint.body.token, /^omb_pu_[A-Za-z0-9_-]{43}$/);
    assert.match(mint.body.pageId, /^p_[A-Za-z0-9_-]{12}$/);
    assert.equal(mint.body.limits.files, 20);

    const html = Buffer.from("<h1>hello</h1>");
    const css = Buffer.from("body{color:red}");
    const upload = multipart(
      { title: "Hi", files: [{ path: "index.html", size: html.length }, { path: "a/b.css", size: css.length }] },
      [html, css],
    );
    const put = await fetch(`${app.base}/v1/pages/${mint.body.pageId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${mint.body.token}`, "content-type": upload.contentType },
      body: upload.body,
    });
    assert.equal(put.status, 200);

    const page = await fetch(`${app.base}/p/${mint.body.pageId}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>hello</h1>");
    assert.equal(page.headers.get("content-security-policy"), "sandbox allow-scripts");
    const sheet = await fetch(`${app.base}/p/${mint.body.pageId}/a/b.css`);
    assert.equal(sheet.status, 200);
    assert.equal(await sheet.text(), "body{color:red}");

    const gone = await call(app.base, "POST", "/api/cloud/pages/token", { action: "delete", pageId: mint.body.pageId }, { authorization: `Bearer ${access.body.token}` });
    assert.equal(gone.status, 200);
    const del = await fetch(`${app.base}/v1/pages/${mint.body.pageId}`, { method: "DELETE", headers: { authorization: `Bearer ${gone.body.token}` } });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${app.base}/p/${mint.body.pageId}/`)).status, 404);
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

test("included pages: a Cloud home mints with its machine signature; bad tokens are refused", async () => {
  const app = await start();
  try {
    const { cloud, secret } = homeCloud(app.store, accountSession(app.store).account.id);

    const body = JSON.stringify({ action: "create" });
    const mint = await call(app.base, "POST", "/api/cloud/pages/token", body,
      homeHeaders(secret, cloud.machine_id, body, "omb-pages-v1"));
    assert.equal(mint.status, 200);
    assert.match(mint.body.pageId, /^p_[A-Za-z0-9_-]{12}$/);

    const wrongAction = await call(app.base, "POST", "/api/cloud/pages/token", { action: "update", pageId: "p_xxxxxxxxxxxx" }, { authorization: `Bearer ${mint.body.token}` });
    assert.equal(wrongAction.status, 401);
    const upload = await fetch(`${app.base}/v1/pages/${mint.body.pageId}`, { method: "PUT", headers: { authorization: "Bearer omb_pu_nope", "content-type": "multipart/form-data; boundary=x" }, body: "--x--\r\n" });
    assert.equal(upload.status, 401);
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

test("included pages: the account cap answers 402 like the upstream contract", async () => {
  const app = await start();
  try {
    const { account, token } = accountSession(app.store);
    for (let index = 0; index < 25; index += 1) app.store.insertPage({ id: `p_${index.toString().padStart(12, "0")}`, accountId: account.id });
    const access = await call(app.base, "POST", "/api/cloud/desktop/services/pages", {}, { authorization: `Bearer ${token}` });
    const mint = await call(app.base, "POST", "/api/cloud/pages/token", { action: "create" }, { authorization: `Bearer ${access.body.token}` });
    assert.equal(mint.status, 402);
    assert.equal(mint.body.error, "pages_limit");
    assert.deepEqual(mint.body.usage, { pages: 25, limit: 25 });
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

test("update.json derives versionCode from versionName", async () => {
  const app = await start();
  try {
    const response = await call(app.base, "GET", "/update.json");
    assert.equal(response.status, 200);
    assert.equal(response.body.versionCode, 20106);
    assert.equal(response.body.versionName, "2.1.6");
  } finally {
    app.server.close();
    app.store.close();
    rmSync(app.pagesDir, { recursive: true, force: true });
  }
});

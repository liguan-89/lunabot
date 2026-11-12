import assert from "node:assert/strict";
import { test } from "node:test";
import { installMarketIpc } from "./market-ipc.mjs";

const NOW = 1_800_000_000_000;
const SUBSCRIPTION = {
  subscription_id: "sub_test_00000001", plan_code: "t20-q", plan_title: "TK1688 API · 20 · 季付",
  status: "active", started_at: 1, expires_at: 1_900_000_000, quota_total: 30_000_000,
  quota_used: 0, quota_remaining: 30_000_000, models: ["claude-sonnet-4-5"],
  token: { id: 1, masked: "sk-****0000", created_at: 1 },
};
const REVEALED = { token: "sk-test-000000000000000000000000000000000000000000000000000000", token_id: 1, expires_at: 1_900_000_000, models: ["claude-sonnet-4-5", "gpt-5.2"] };

function harness({ subscription = SUBSCRIPTION, reveal = async () => REVEALED, rotate = async () => REVEALED,
  checkout = async (planCode, paymentMethod) => ({ checkout_id: "chk_test_00000001", status: "pending_payment", url: `https://tk1688.com/pay/${planCode}?method=${paymentMethod}`, expires_at: 1 }) } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const opened = [];
  const requests = [];
  const writes = [];
  let record = null;
  const store = { read: async () => record, write: async (value) => { record = value; writes.push(value); } };
  const client = {
    state: () => ({ status: "signed-in", user: { id: 1, username: "fixture" } }),
    plans: async () => ({ contractVersion: 1, plans: [] }),
    subscriptions: async () => ({ contractVersion: 1, subscriptions: [subscription] }),
    signIn: async () => ({ status: "signed-in", user: { id: 1 } }),
    signOut: async () => ({ status: "signed-out" }),
    checkout,
    checkoutStatus: async () => ({ checkout_id: "chk_test_00000001", status: "active", expires_at: 1 }),
    revealToken: reveal,
    rotateToken: rotate,
  };
  const localRequest = async (route, init) => {
    requests.push({ route, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ instanceId: "openai-compat-test" }) };
  };
  installMarketIpc({
    ipcMain, localOnly: (_channel, handler) => handler, client: () => client, openBrowser: async (url) => { opened.push(url); },
    localRequest, providerStore: store, origin: "https://tk1688.com", apiBase: "https://api.tk1688.com/v1", now: () => NOW,
  });
  return { handlers, opened, requests, writes, store, record: () => record, setRecord: (value) => { record = value; } };
}

test("installs the issued key as an OpenAI-compatible engine without returning the key", async () => {
  const harnessed = harness();
  const result = await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  assert.deepEqual(result, { instanceId: "openai-compat-test", models: ["claude-sonnet-4-5", "gpt-5.2"], expiresAt: 1_900_000_000, url: "https://api.tk1688.com/v1", installed: true });
  assert.equal(harnessed.requests.length, 1);
  assert.equal(harnessed.requests[0].route, "/api/instances/openai-compat");
  assert.deepEqual(harnessed.requests[0].body, {
    displayName: "TK1688 API", url: "https://api.tk1688.com/v1", key: REVEALED.token, models: ["claude-sonnet-4-5", "gpt-5.2"],
  });
  assert.equal(JSON.stringify(result).includes("sk-test"), false);
  assert.equal(harnessed.record().instance_id, "openai-compat-test");
  assert.equal(harnessed.record().subscription_id, SUBSCRIPTION.subscription_id);
});

test("reuses an install that is still live instead of adding a second engine", async () => {
  const harnessed = harness();
  await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  const again = await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  assert.equal(again.instanceId, "openai-compat-test");
  assert.equal(harnessed.requests.length, 1);
});

test("rotates when the key was already shown once", async () => {
  let rotated = 0;
  const harnessed = harness({
    reveal: async () => { throw Object.assign(new Error("shown"), { code: "token_already_revealed" }); },
    rotate: async () => { rotated += 1; return { ...REVEALED, token: "sk-rotated-00000000000000000000000000000000000000000000000000" }; },
  });
  await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  assert.equal(rotated, 1);
  assert.match(harnessed.requests[0].body.key, /^sk-rotated-/);
});

test("refuses an expired subscription before revealing a key", async () => {
  const harnessed = harness({ subscription: { ...SUBSCRIPTION, status: "expired", expires_at: 1 } });
  await assert.rejects(harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id), /Renew this subscription/);
  assert.equal(harnessed.requests.length, 0);
});

test("opens only the checkout address main received", async () => {
  const harnessed = harness();
  const checkout = await harnessed.handlers.get("market:checkout")(undefined, "t20-q", "epay");
  assert.equal(checkout.checkout_id, "chk_test_00000001");
  assert.deepEqual(harnessed.opened, ["https://tk1688.com/pay/t20-q?method=epay"]);
});

test("rebuilds a token row that reveal says is gone", async () => {
  let rotated = 0;
  const harnessed = harness({
    reveal: async () => { throw Object.assign(new Error("gone"), { code: "subscription_not_found", status: 404 }); },
    rotate: async () => { rotated += 1; return REVEALED; },
  });
  await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  assert.equal(rotated, 1);
  assert.match(harnessed.requests[0].body.key, /^sk-test-/);
});

test("rebuilds directly when the subscription has no token row", async () => {
  let revealed = 0, rotated = 0;
  const harnessed = harness({
    subscription: { ...SUBSCRIPTION, token: null },
    reveal: async () => { revealed += 1; return REVEALED; },
    rotate: async () => { rotated += 1; return REVEALED; },
  });
  await harnessed.handlers.get("market:install")(undefined, SUBSCRIPTION.subscription_id);
  assert.equal(revealed, 0);
  assert.equal(rotated, 1);
});

test("does not open a browser for an order that settled without a checkout page", async () => {
  const harnessed = harness({ checkout: async () => ({ checkout_id: "chk_test_00000002", status: "active" }) });
  const checkout = await harnessed.handlers.get("market:checkout")(undefined, "t20-m", "balance");
  assert.equal(checkout.status, "active");
  assert.deepEqual(harnessed.opened, []);
});

test("reports the persisted install", async () => {
  const harnessed = harness();
  harnessed.setRecord({ subscription_id: SUBSCRIPTION.subscription_id, instance_id: "openai-compat-test", expires_at: 1_900_000_000, models: [], url: "https://api.tk1688.com/v1" });
  assert.deepEqual(await harnessed.handlers.get("market:installed")(), {
    subscriptionId: SUBSCRIPTION.subscription_id, instanceId: "openai-compat-test", expiresAt: 1_900_000_000,
  });
});
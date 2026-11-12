import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createMarketClient, MarketError, MARKET_CLIENT_ID, MARKET_SCOPES } from "./market-client.mjs";

const ACCESS_1 = "mkt_test_access_0000000000000001";
const ACCESS_2 = "mkt_test_access_0000000000000002";
const REFRESH_1 = "mkr_test_refresh_000000000000001";
const REFRESH_2 = "mkr_test_refresh_000000000000002";
const USER = { id: 1, username: "fixture", display_name: "Fixture User" };
const PLANS = [
  {
    plan_code: "t20-m", tier_code: "t20", title: "TK1688 API · 20 · 月付", subtitle: "个人开发者",
    billing_period: "month", months: 1, price_usd: 20, list_price_usd: 20, discount_percent: 0, currency: "USD",
    token_quota: 10000000, quota_usd: 20, days: 30, models: ["claude-sonnet-4-5", "gpt-5.2"],
    payment_methods: ["epay", "balance"], sort_order: 30,
  },
  {
    plan_code: "t20-q", tier_code: "t20", title: "TK1688 API · 20 · 季付", subtitle: "个人开发者 · 省 10%",
    billing_period: "quarter", months: 3, price_usd: 54, list_price_usd: 60, discount_percent: 10, currency: "USD",
    token_quota: 30000000, quota_usd: 60, days: 90, models: ["claude-sonnet-4-5", "gpt-5.2"],
    payment_methods: ["epay", "balance"], sort_order: 31,
  },
];
const SUBSCRIPTION = {
  subscription_id: "sub_test_00000001", plan_code: "t20-q", plan_title: "TK1688 API · 20 · 季付",
  status: "active", started_at: 1762999000, expires_at: 1770765400,
  quota_total: 30000000, quota_used: 120000, quota_remaining: 29880000,
  models: ["claude-sonnet-4-5", "gpt-5.2"],
  token: { id: 9001, masked: "sk-****9f2a", created_at: 1762999000 },
};

const hash = (value) => createHash("sha256").update(value).digest("base64url");
const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});

async function mockMarket() {
  const state = {
    codes: new Map(),
    refresh: new Set([REFRESH_1]),
    access: new Set([ACCESS_1]),
    checkoutPolls: 0,
    reveals: 0,
    revoked: null,
    authorize: null,
    paths: [],
    numericReveal: false,
    nullToken: false,
  };
  let base = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    state.paths.push(`${request.method} ${url.pathname}`);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/api/market/oauth/token") {
      const body = new URLSearchParams(await readBody(request));
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const entry = state.codes.get(body.get("code"));
        if (!entry || body.get("client_id") !== MARKET_CLIENT_ID || body.get("redirect_uri") !== entry.redirectUri) {
          return send(400, { error: "invalid_grant", error_description: "bad code" });
        }
        if (hash(body.get("code_verifier") ?? "") !== entry.challenge) {
          return send(400, { error: "invalid_grant", error_description: "bad verifier" });
        }
        state.codes.delete(body.get("code"));
        return send(200, {
          access_token: ACCESS_1, token_type: "Bearer", expires_in: 3600,
          refresh_token: REFRESH_1, scope: MARKET_SCOPES.join(" "), user: USER,
        }, { "cache-control": "no-store" });
      }
      if (grant === "refresh_token") {
        const presented = body.get("refresh_token");
        if (!state.refresh.has(presented)) return send(400, { error: "invalid_grant", error_description: "reused refresh" });
        state.refresh.delete(presented);
        state.refresh.add(REFRESH_2);
        state.access.add(ACCESS_2);
        state.access.delete(ACCESS_1);
        return send(200, {
          access_token: ACCESS_2, token_type: "Bearer", expires_in: 3600,
          refresh_token: REFRESH_2, scope: MARKET_SCOPES.join(" "), user: USER,
        });
      }
      return send(400, { error: "invalid_request" });
    }
    if (request.method === "POST" && url.pathname === "/api/market/oauth/revoke") {
      state.revoked = new URLSearchParams(await readBody(request)).get("token");
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/market/plans") {
      return send(200, { contract_version: 1, plans: PLANS });
    }
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!state.access.has(token)) return send(401, { error: { code: "unauthorized", message: "Sign in first.", request_id: "req_auth" } });
    if (request.method === "GET" && url.pathname === "/api/market/subscriptions") {
      return send(200, { contract_version: 1, subscriptions: [state.nullToken ? { ...SUBSCRIPTION, token: null } : SUBSCRIPTION] });
    }
    if (request.method === "POST" && url.pathname === "/api/market/checkout") {
      const body = JSON.parse(await readBody(request));
      if (body.plan_code === "t20-m") {
        return send(200, { checkout_id: "chk_test_00000002", status: "active", subscription_id: SUBSCRIPTION.subscription_id });
      }
      assert.equal(body.plan_code, "t20-q");
      assert.equal(request.headers["idempotency-key"]?.length > 10, true);
      return send(200, {
        checkout_id: "chk_test_00000001", status: "pending_payment",
        url: `${base}/pay/chk_test_00000001?ticket=fixture`, expires_at: 1763000000,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/market/checkout/chk_test_00000001") {
      state.checkoutPolls += 1;
      return send(200, state.checkoutPolls === 1
        ? { checkout_id: "chk_test_00000001", status: "pending_payment", expires_at: 1763000000 }
        : { checkout_id: "chk_test_00000001", status: "active", subscription_id: SUBSCRIPTION.subscription_id, paid_at: 1762999000, expires_at: 1763000000 });
    }
    const numericReveal = /^\/api\/market\/subscriptions\/(\d+)\/token$/.exec(url.pathname);
    if (request.method === "POST" && numericReveal) {
      state.numericReveal = true;
      return send(200, {
        token: "sk-numeric00000000000000000000000000000000000000000000000000",
        token_id: 9001, expires_at: 1770765400, models: SUBSCRIPTION.models,
      });
    }
    if (request.method === "POST" && url.pathname === `/api/market/subscriptions/${SUBSCRIPTION.subscription_id}/token`) {
      state.reveals += 1;
      if (state.reveals > 1) return send(409, { error: { code: "token_already_revealed", message: "Already shown.", request_id: "req_token" } });
      return send(200, {
        token: "sk-fixture000000000000000000000000000000000000000000000000",
        token_id: 9001, expires_at: 1770765400, models: SUBSCRIPTION.models,
      });
    }
    send(404, { error: { code: "not_found", message: "No route.", request_id: "req_404" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, state, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function store(initial = null) {
  return {
    value: initial,
    writes: [],
    async read() { return this.value ? structuredClone(this.value) : null; },
    async write(value) { this.value = value === null ? null : structuredClone(value); this.writes.push(this.value); },
  };
}

function browserFor(mock, options = {}) {
  return async (authorizeUrl) => {
    const url = new URL(authorizeUrl);
    assert.equal(url.origin + url.pathname, `${mock.base}/oauth/authorize`);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), MARKET_CLIENT_ID);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), MARKET_SCOPES.join(" "));
    const code = `code-${randomUUID()}`;
    const redirectUri = url.searchParams.get("redirect_uri");
    mock.state.codes.set(code, { challenge: options.challenge ?? url.searchParams.get("code_challenge"), redirectUri });
    const state = options.state ?? url.searchParams.get("state");
    await fetch(`${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  };
}

async function signedIn(mock, options = {}) {
  const saved = store();
  const client = createMarketClient({
    store: saved, openBrowser: browserFor(mock, options), origin: mock.base, fixture: true, apiOrigin: mock.base,
    fetch, now: () => 1_000_000, waitMs: options.waitMs ?? 1_000,
  });
  await client.start();
  await client.signIn();
  return { client, saved };
}

test("signs in with PKCE, stores the refresh token and reads plans", async () => {
  const mock = await mockMarket();
  try {
    const { client, saved } = await signedIn(mock);
    assert.deepEqual(client.state(), { status: "signed-in", user: USER });
    assert.equal(saved.value.refresh_token, REFRESH_1);
    assert.equal(saved.value.access_token, ACCESS_1);
    const plans = await client.plans();
    assert.equal(plans.contractVersion, 1);
    assert.deepEqual(plans.plans.map((plan) => plan.plan_code), ["t20-m", "t20-q"]);
    const subscriptions = await client.subscriptions();
    assert.equal(subscriptions.subscriptions[0].quota_remaining, 29880000);
  } finally {
    await mock.close();
  }
});

test("refuses a callback whose state does not match", async () => {
  const mock = await mockMarket();
  try {
    const saved = store();
    const client = createMarketClient({
      store: saved, openBrowser: browserFor(mock, { state: "wrong-state", waitMs: 50 }), origin: mock.base, fixture: true,
      apiOrigin: mock.base, fetch, now: () => 1_000_000, waitMs: 80,
    });
    await client.start();
    await assert.rejects(client.signIn(), (error) => error instanceof MarketError && error.code === "sign_in_timeout");
    assert.equal(saved.value, null);
    assert.deepEqual(client.state(), { status: "signed-out", message: "sign_in_timeout" });
  } finally {
    await mock.close();
  }
});

test("keeps the sign-in signed out when the token endpoint refuses the PKCE verifier", async () => {
  const mock = await mockMarket();
  try {
    const saved = store();
    const client = createMarketClient({
      store: saved, openBrowser: browserFor(mock, { challenge: "wrong-challenge" }), origin: mock.base, fixture: true,
      apiOrigin: mock.base, fetch, now: () => 1_000_000, waitMs: 1_000,
    });
    await client.start();
    await assert.rejects(client.signIn(), (error) => error instanceof MarketError && error.code === "invalid_grant");
    assert.equal(saved.value, null);
    assert.equal(client.state().status, "signed-out");
  } finally {
    await mock.close();
  }
});

test("refreshes an expired access token and rotates the refresh token", async () => {
  const mock = await mockMarket();
  try {
    let clock = 1_000_000;
    const saved = store();
    const client = createMarketClient({
      store: saved, openBrowser: browserFor(mock), origin: mock.base, fixture: true, apiOrigin: mock.base,
      fetch, now: () => clock, waitMs: 1_000,
    });
    await client.start();
    await client.signIn();
    clock += 3_600_000;
    const subscriptions = await client.subscriptions();
    assert.equal(subscriptions.subscriptions.length, 1);
    assert.equal(saved.value.access_token, ACCESS_2);
    assert.equal(saved.value.refresh_token, REFRESH_2);

    const replay = store({
      version: 1, access_token: ACCESS_1, refresh_token: REFRESH_1, expires_at: clock - 1,
      user: USER, scope: MARKET_SCOPES.join(" "),
    });
    const stale = createMarketClient({
      store: replay, openBrowser: async () => {}, origin: mock.base, fixture: true, apiOrigin: mock.base,
      fetch, now: () => clock, waitMs: 1_000,
    });
    await stale.start();
    assert.equal(stale.state().status, "signed-out");
    assert.equal(stale.state().message, "session-ended");
    assert.equal(replay.value, null);
  } finally {
    await mock.close();
  }
});

test("checkout polls to active, reveals a token once and refuses a second reveal", async () => {
  const mock = await mockMarket();
  try {
    const { client } = await signedIn(mock);
    const checkout = await client.checkout("t20-q");
    assert.equal(checkout.status, "pending_payment");
    const active = await client.waitForCheckout(checkout.checkout_id, { intervalMs: 1, timeoutMs: 1_000 });
    assert.equal(active.status, "active");
    const revealed = await client.revealToken(SUBSCRIPTION.subscription_id);
    assert.equal(revealed.token_id, 9001);
    await assert.rejects(client.revealToken(SUBSCRIPTION.subscription_id), (error) => error instanceof MarketError && error.code === "token_already_revealed");
  } finally {
    await mock.close();
  }
});

test("signs out by revoking and forgetting the stored tokens", async () => {
  const mock = await mockMarket();
  try {
    const { client, saved } = await signedIn(mock);
    const state = await client.signOut();
    assert.deepEqual(state, { status: "signed-out" });
    assert.equal(saved.value, null);
    assert.equal(mock.state.revoked, REFRESH_1);
  } finally {
    await mock.close();
  }
});

test("cancels a sign-in that never reaches the browser callback", async () => {
  const mock = await mockMarket();
  try {
    let opened;
    const browserStarted = new Promise((resolve) => { opened = resolve; });
    const saved = store();
    const client = createMarketClient({
      store: saved, openBrowser: async () => { opened(); }, origin: mock.base, fixture: true, apiOrigin: mock.base,
      fetch, now: () => 1_000_000, waitMs: 60_000,
    });
    await client.start();
    const pending = client.signIn();
    await browserStarted;
    client.cancelSignIn();
    await assert.rejects(pending, (error) => error instanceof MarketError && error.code === "cancelled");
    assert.equal(saved.value, null);
    assert.equal(client.state().status, "signed-out");
  } finally {
    await mock.close();
  }
});

test("refreshes an expired access token before revoking on sign-out", async () => {
  const mock = await mockMarket();
  try {
    let clock = 1_000_000;
    const saved = store();
    const client = createMarketClient({
      store: saved, openBrowser: browserFor(mock), origin: mock.base, fixture: true, apiOrigin: mock.base,
      fetch, now: () => clock, waitMs: 1_000,
    });
    await client.start();
    await client.signIn();
    clock += 3_600_000;
    const state = await client.signOut();
    assert.deepEqual(state, { status: "signed-out" });
    assert.equal(saved.value, null);
    assert.equal(mock.state.revoked, REFRESH_2, "the rotated refresh token is the one revoked");
  } finally {
    await mock.close();
  }
});

test("rejects an unsupported plan code before any request", async () => {
  const mock = await mockMarket();
  try {
    const { client } = await signedIn(mock);
    await assert.rejects(client.checkout("BAD CODE"), (error) => error instanceof MarketError && error.code === "invalid_request");
  } finally {
    await mock.close();
  }
});

test("calls the token route with the numeric id inside a sub_ id", async () => {
  const mock = await mockMarket();
  try {
    const { client } = await signedIn(mock);
    const revealed = await client.revealToken("sub_12345678");
    assert.match(revealed.token, /^sk-numeric/);
    assert.equal(mock.state.numericReveal, true);
    assert.ok(mock.state.paths.includes("POST /api/market/subscriptions/12345678/token"));
  } finally {
    await mock.close();
  }
});

test("keeps a legacy subscription whose token row is gone", async () => {
  const mock = await mockMarket();
  try {
    const { client } = await signedIn(mock);
    mock.state.nullToken = true;
    const subscriptions = await client.subscriptions();
    assert.equal(subscriptions.subscriptions[0].token, null);
  } finally {
    await mock.close();
  }
});

test("accepts an order that settled without a checkout page", async () => {
  const mock = await mockMarket();
  try {
    const { client } = await signedIn(mock);
    const checkout = await client.checkout("t20-m");
    assert.equal(checkout.status, "active");
    assert.equal(checkout.url, undefined);
  } finally {
    await mock.close();
  }
});
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createManagedDesktopStore } from "./managed-desktop.mjs";

export const MARKET_ORIGIN = "https://tk1688.com";
export const MARKET_API_ORIGIN = "https://api.tk1688.com";
export const MARKET_CLIENT_ID = "dexbot-desktop";
export const MARKET_SCOPES = Object.freeze([
  "market.plans.read",
  "market.subscription.read",
  "market.subscription.purchase",
  "market.subscription.token.read",
]);
export const createMarketStore = createManagedDesktopStore;

const ACCESS = /^mkt_[A-Za-z0-9_-]{16,}$/;
const REFRESH = /^mkr_[A-Za-z0-9_-]{16,}$/;
const PLAN_CODE = /^[a-z][a-z0-9-]{1,32}$/;
const TIER_CODE = /^[a-z][a-z0-9-]{1,32}$/;
const CHECKOUT_ID = /^chk_[A-Za-z0-9_-]{8,64}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{8,64}$/;
const NUMERIC_SUBSCRIPTION = /^sub_(\d+)$/;
const PAYMENT_METHODS = Object.freeze(["epay", "balance"]);
const PERIODS = Object.freeze(["month", "quarter", "year"]);
const SUBSCRIPTION_STATES = Object.freeze(["active", "expiring", "expired", "canceled"]);
const CHECKOUT_STATES = Object.freeze(["pending_payment", "paid", "active", "failed", "expired", "canceled"]);
const ACCESS_LEEWAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_MS = 5 * 60_000;

const base64url = (buffer) => buffer.toString("base64url");
const isText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isAmount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const subscriptionPathId = (id) => NUMERIC_SUBSCRIPTION.exec(id)?.[1] ?? id;

export class MarketError extends Error {
  constructor(code, message, { status = 0, requestId = "" } = {}) {
    super(message);
    this.name = "MarketError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** Production, or an http loopback fixture in tests; no other address is ever accepted. */
export function marketOrigin(value = MARKET_ORIGIN, fixture = false) {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (value !== url.origin || (value !== MARKET_ORIGIN && !(fixture && loopback))) throw new Error("Invalid TK1688 address.");
  return value;
}

/** The API host is a separate origin from the web host in production. */
export function marketApiOrigin(value = MARKET_API_ORIGIN, fixture = false) {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (value !== url.origin || (value !== MARKET_API_ORIGIN && !(fixture && loopback))) throw new Error("Invalid TK1688 API address.");
  return value;
}

export function marketTarget(env = process.env) {
  const fixture = typeof env?.LUNABOT_MARKET_FIXTURE === "string" ? env.LUNABOT_MARKET_FIXTURE.trim() : "";
  if (!fixture) return { origin: MARKET_ORIGIN, apiOrigin: MARKET_API_ORIGIN, fixture: false };
  const apiFixture = typeof env?.LUNABOT_MARKET_API_FIXTURE === "string" ? env.LUNABOT_MARKET_API_FIXTURE.trim() : "";
  return { origin: marketOrigin(fixture, true), apiOrigin: marketApiOrigin(apiFixture || fixture, true), fixture: true };
}

export function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

function sameState(expected, received) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(expected), right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseUser(value) {
  if (!value || typeof value !== "object" || !isId(value.id)) return null;
  const username = isText(value.username, 128) ? value.username : undefined;
  const displayName = isText(value.display_name, 128) ? value.display_name : undefined;
  return { id: value.id, ...(username ? { username } : {}), ...(displayName ? { display_name: displayName } : {}) };
}

function parseTokenResponse(body, previousUser = null) {
  if (!body || typeof body !== "object") return null;
  if (body.token_type !== "Bearer") return null;
  if (!ACCESS.test(body.access_token ?? "") || !REFRESH.test(body.refresh_token ?? "")) return null;
  const expiresIn = body.expires_in;
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400) return null;
  const user = parseUser(body.user) ?? previousUser;
  if (!user) return null;
  const scope = typeof body.scope === "string" ? body.scope : "";
  return { access: body.access_token, refresh: body.refresh_token, expiresIn, user, scope };
}

function savedRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (!ACCESS.test(value.access_token ?? "") || !REFRESH.test(value.refresh_token ?? "")) return null;
  if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) return null;
  const user = parseUser(value.user);
  if (!user) return null;
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expiresAt: value.expires_at,
    user,
    scope: typeof value.scope === "string" ? value.scope : "",
  };
}

function storedRecord(tokens) {
  return {
    version: 1,
    access_token: tokens.access,
    refresh_token: tokens.refresh,
    expires_at: tokens.expiresAt,
    user: tokens.user,
    scope: tokens.scope,
  };
}

function errorCode(status, body) {
  const raw = body?.error;
  if (typeof raw === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(raw)) return raw;
  const code = raw?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(code)) return code;
  if (status === 401) return "unauthorized";
  if (status === 403) return "insufficient_scope";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "checkout_expired";
  if (status === 429) return "rate_limited";
  return "server_error";
}

function apiError(status, body) {
  const code = errorCode(status, body);
  const raw = body?.error;
  const message = typeof raw === "string"
    ? (isText(body?.error_description, 512) ? body.error_description : `TK1688 answered ${status}.`)
    : isText(raw?.message, 512) ? raw.message : `TK1688 answered ${status}.`;
  const requestId = isText(raw?.request_id, 128) ? raw.request_id : "";
  return new MarketError(code, message, { status, requestId });
}

function protocolError(detail) {
  return new MarketError("protocol_error", `TK1688 sent an unexpected answer: ${detail}.`);
}

function parsePlan(value) {
  if (!value || typeof value !== "object") return null;
  if (!PLAN_CODE.test(value.plan_code ?? "") || !TIER_CODE.test(value.tier_code ?? "")) return null;
  if (!PERIODS.includes(value.billing_period) || ![1, 3, 12].includes(value.months)) return null;
  if (!isText(value.title, 128) || !isAmount(value.price_usd) || !isAmount(value.list_price_usd)) return null;
  if (![0, 10, 20].includes(value.discount_percent) || value.currency !== "USD") return null;
  if (!isAmount(value.token_quota) || !isAmount(value.quota_usd) || !Number.isSafeInteger(value.days) || value.days < 1) return null;
  if (!Array.isArray(value.models) || !value.models.every((model) => isText(model, 200))) return null;
  if (!Array.isArray(value.payment_methods) || !value.payment_methods.every((method) => PAYMENT_METHODS.includes(method))) return null;
  if (!Number.isSafeInteger(value.sort_order)) return null;
  return { ...value };
}

function parseSubscription(value) {
  if (!value || typeof value !== "object") return null;
  if (!SUBSCRIPTION_ID.test(value.subscription_id ?? "") || !PLAN_CODE.test(value.plan_code ?? "")) return null;
  if (!SUBSCRIPTION_STATES.includes(value.status) || !isText(value.plan_title, 128)) return null;
  if (!Number.isSafeInteger(value.started_at) || !Number.isSafeInteger(value.expires_at)) return null;
  if (!isAmount(value.quota_total) || !isAmount(value.quota_used) || !isAmount(value.quota_remaining)) return null;
  if (!Array.isArray(value.models) || !value.models.every((model) => isText(model, 200))) return null;
  const token = value.token ?? null;
  if (token !== null && (typeof token !== "object" || !isId(token.id) || !isText(token.masked, 64) || !Number.isSafeInteger(token.created_at))) return null;
  return { ...value, token };
}

function parseTokenReveal(value) {
  if (!value || typeof value !== "object") return null;
  if (!isText(value.token, 512) || !value.token.startsWith("sk-")) return null;
  if (!isId(value.token_id) || !Number.isSafeInteger(value.expires_at)) return null;
  if (!Array.isArray(value.models) || !value.models.every((model) => isText(model, 200))) return null;
  return { ...value };
}

function loopbackServer(onRequest) {
  return createServer((request, response) => {
    const fail = (status, text) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
      response.end(text);
    };
    if (request.method !== "GET") return fail(405, "Method not allowed.");
    onRequest(request, response, fail);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(server.address().port); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

export function createMarketClient({
  store,
  openBrowser,
  origin = MARKET_ORIGIN,
  apiOrigin = MARKET_API_ORIGIN,
  clientId = MARKET_CLIENT_ID,
  scopes = MARKET_SCOPES,
  fixture = false,
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  onState = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  waitMs = DEFAULT_WAIT_MS,
}) {
  origin = marketOrigin(origin, fixture);
  apiOrigin = marketApiOrigin(apiOrigin, fixture);
  const cleanCheckoutUrl = (value) => {
    if (typeof value !== "string" || value.length > 2048) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    if (url.protocol !== "https:" && !(fixture && url.protocol === "http:")) return null;
    return url.href;
  };
  let tokens = null;
  let value = { status: "signed-out", message: "restoring" };
  let started = null;
  let signingIn = null;
  let cancelActiveSignIn = null;
  let refreshing = null;

  const state = () => structuredClone(value);
  const publish = (next) => { value = next; onState(state()); return state(); };
  const signedIn = () => publish({ status: "signed-in", user: tokens.user });

  async function save(next) {
    tokens = next;
    try {
      await store.write(storedRecord(next));
    } catch {
      tokens = null;
      throw new MarketError("store_unavailable", "Could not save the TK1688 sign-in on this computer.", { status: 0 });
    }
  }

  async function clear() {
    tokens = null;
    try { await store.write(null); } catch {}
  }

  async function exchange(params, previousUser = null) {
    let response;
    try {
      response = await fetcher(new URL("/api/market/oauth/token", apiOrigin), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MarketError("unreachable", "Could not reach TK1688 to finish signing in.");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw apiError(response.status, body);
    const parsed = parseTokenResponse(body, previousUser);
    if (!parsed) throw protocolError("token response");
    return { access: parsed.access, refresh: parsed.refresh, expiresAt: now() + parsed.expiresIn * 1000, user: parsed.user, scope: parsed.scope };
  }

  async function refreshAccess() {
    if (!tokens?.refresh) throw new MarketError("signed_out", "Sign in to TK1688 first.", { status: 401 });
    if (!refreshing) {
      refreshing = exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: clientId }, tokens.user)
        .then(async (next) => { await save(next); return signedIn(); })
        .catch(async (error) => {
          if (error?.code === "invalid_grant" || error?.code === "expired_token" || error?.code === "unauthorized") {
            await clear();
            publish({ status: "signed-out", message: "session-ended" });
          }
          throw error;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function accessToken() {
    if (!tokens) throw new MarketError("signed_out", "Sign in to TK1688 first.", { status: 401 });
    if (now() >= tokens.expiresAt - ACCESS_LEEWAY_MS) await refreshAccess();
    return tokens.access;
  }

  async function request(path, { method = "GET", body, auth = true, idempotencyKey, retry = true } = {}) {
    if (!path.startsWith("/api/market/")) throw new Error("Invalid market path.");
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (auth) headers.authorization = `Bearer ${await accessToken()}`;
    let response;
    try {
      response = await fetcher(new URL(path, apiOrigin), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MarketError("unreachable", "Could not reach TK1688.");
    }
    if (response.status === 401 && auth && retry) {
      await refreshAccess();
      return request(path, { method, body, auth, idempotencyKey, retry: false });
    }
    const answer = await response.json().catch(() => null);
    if (!response.ok) throw apiError(response.status, answer);
    if (!answer || typeof answer !== "object") throw protocolError("empty response");
    return answer;
  }

  async function begin(signal) {
    const pkce = createPkce();
    let settle;
    let timer;
    let server;
    const callback = new Promise((resolve, reject) => {
      settle = (error, code) => {
        if (!settle.open) return;
        settle.open = false;
        clearTimer(timer);
        server?.close();
        if (error) reject(error); else resolve(code);
      };
      settle.open = true;
    });
    cancelActiveSignIn = () => settle(new MarketError("cancelled", "Sign-in was cancelled."));
    timer = setTimer(() => settle(new MarketError("sign_in_timeout", "TK1688 sign-in timed out. Try again.")), waitMs);
    server = loopbackServer((incoming, response, fail) => {
      const url = new URL(incoming.url, "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback") return fail(404, "Not found.");
      if (!sameState(pkce.state, url.searchParams.get("state"))) return fail(400, "This sign-in does not match. Start again from the app.");
      const error = url.searchParams.get("error");
      if (error) return fail(400, error === "access_denied" ? "Sign-in was cancelled." : "TK1688 refused the sign-in.");
      const code = url.searchParams.get("code");
      if (!isText(code, 512)) return fail(400, "TK1688 sent no authorization code.");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
      response.end("<!doctype html><title>Luna Bot</title><p>Signed in to TK1688. You can close this window.</p>");
      settle(null, code);
    });
    server.once("error", (error) => settle(error));
    const port = await listen(server);
    if (signal?.aborted) {
      const failure = new MarketError("cancelled", "Sign-in was cancelled.");
      settle(failure);
      await callback.catch(() => {});
      throw failure;
    }
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const authorize = new URL("/oauth/authorize", origin);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", scopes.join(" "));
    authorize.searchParams.set("state", pkce.state);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    try {
      await openBrowser(authorize.href);
    } catch {
      const failure = new MarketError("browser_unavailable", "Could not open the browser for TK1688 sign-in.");
      settle(failure);
      await callback.catch(() => {});
      throw failure;
    }
    let code;
    try {
      code = await callback;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new MarketError("sign_in_failed", "TK1688 sign-in failed.");
    }
    const next = await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    await save(next);
    return signedIn();
  }

  async function checkoutStatus(checkoutId) {
    if (!CHECKOUT_ID.test(checkoutId ?? "")) throw new MarketError("invalid_request", "Unknown checkout.");
    const body = await request(`/api/market/checkout/${encodeURIComponent(checkoutId)}`);
    if (!CHECKOUT_ID.test(body.checkout_id ?? "") || !CHECKOUT_STATES.includes(body.status)) throw protocolError("checkout status");
    return body;
  }

  return {
    async start() {
      if (started) return started;
      started = (async () => {
        let saved;
        try { saved = savedRecord(await store.read()); } catch { saved = null; }
        if (!saved) return publish({ status: "signed-out" });
        tokens = saved;
        if (now() < saved.expiresAt - ACCESS_LEEWAY_MS) return signedIn();
        publish({ status: "connecting" });
        try { return await refreshAccess(); } catch { return state(); }
      })();
      return started;
    },

    state,

    signIn() {
      if (signingIn) return signingIn;
      signingIn = begin().catch((error) => {
        if (value.status !== "signed-in") publish({ status: "signed-out", message: error?.code ?? "sign_in_failed" });
        throw error;
      }).finally(() => { signingIn = null; cancelActiveSignIn = null; });
      return signingIn;
    },

    cancelSignIn() {
      cancelActiveSignIn?.();
      return state();
    },

    async signOut() {
      let access = null;
      try { access = await accessToken(); } catch {}
      const refresh = tokens?.refresh ?? null;
      if (refresh || access) {
        try {
          await fetcher(new URL("/api/market/oauth/revoke", apiOrigin), {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              ...(access ? { authorization: `Bearer ${access}` } : {}),
            },
            body: new URLSearchParams({ token: refresh ?? access, ...(refresh ? { token_type_hint: "refresh_token" } : {}) }).toString(),
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {}
      }
      await clear();
      return publish({ status: "signed-out" });
    },

    async plans() {
      const body = await request("/api/market/plans", { auth: false });
      if (body.contract_version !== 1 || !Array.isArray(body.plans)) throw protocolError("plans");
      const plans = body.plans.map(parsePlan);
      if (plans.some((plan) => plan === null)) throw protocolError("plan");
      return { contractVersion: 1, plans };
    },

    async subscriptions() {
      const body = await request("/api/market/subscriptions");
      if (body.contract_version !== 1 || !Array.isArray(body.subscriptions)) throw protocolError("subscriptions");
      const subscriptions = body.subscriptions.map(parseSubscription);
      if (subscriptions.some((subscription) => subscription === null)) throw protocolError("subscription");
      return { contractVersion: 1, subscriptions };
    },

    async checkout(planCode, paymentMethod = "epay") {
      if (!PLAN_CODE.test(planCode ?? "")) throw new MarketError("invalid_request", "Choose a plan.");
      if (!PAYMENT_METHODS.includes(paymentMethod)) throw new MarketError("invalid_request", "Choose a payment method.");
      const body = await request("/api/market/checkout", {
        method: "POST",
        body: { plan_code: planCode, payment_method: paymentMethod },
        idempotencyKey: randomUUID(),
      });
      const url = cleanCheckoutUrl(body.url);
      if (!CHECKOUT_ID.test(body.checkout_id ?? "") || !CHECKOUT_STATES.includes(body.status)) throw protocolError("checkout");
      const waiting = body.status === "pending_payment" || body.status === "paid";
      const expiresAt = Number.isSafeInteger(body.expires_at) && body.expires_at > 0 ? body.expires_at : undefined;
      if (waiting && (!url || expiresAt === undefined)) throw protocolError("checkout");
      return { ...body, ...(url ? { url } : {}), ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) };
    },

    checkoutStatus,

    async waitForCheckout(checkoutId, { intervalMs = 2_000, timeoutMs = 15 * 60_000 } = {}) {
      const deadline = now() + timeoutMs;
      for (;;) {
        const status = await checkoutStatus(checkoutId);
        if (["active", "failed", "expired", "canceled"].includes(status.status)) return status;
        if (now() >= deadline) throw new MarketError("checkout_timeout", "Payment has not finished yet.");
        await new Promise((resolve) => setTimer(resolve, intervalMs));
      }
    },

    async revealToken(subscriptionId) {
      if (!SUBSCRIPTION_ID.test(subscriptionId ?? "")) throw new MarketError("invalid_request", "Unknown subscription.");
      const body = await request(`/api/market/subscriptions/${encodeURIComponent(subscriptionPathId(subscriptionId))}/token`, { method: "POST" });
      const revealed = parseTokenReveal(body);
      if (!revealed) throw protocolError("token");
      return revealed;
    },

    async rotateToken(subscriptionId) {
      if (!SUBSCRIPTION_ID.test(subscriptionId ?? "")) throw new MarketError("invalid_request", "Unknown subscription.");
      const body = await request(`/api/market/subscriptions/${encodeURIComponent(subscriptionPathId(subscriptionId))}/token/rotate`, { method: "POST" });
      const revealed = parseTokenReveal(body);
      if (!revealed) throw protocolError("token");
      return revealed;
    },
  };
}
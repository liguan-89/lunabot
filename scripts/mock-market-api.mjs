#!/usr/bin/env node
// Dev-only TK1688 market mock: the contract's plans, OAuth PKCE, checkout and token flow, plus
// /v1/models and a tiny chat completion so an installed engine answers. Never used in a packaged app.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.LUNABOT_MARKET_MOCK_PORT ?? 4010);
const ACCESS = "mkt_mock_access_0000000000000001";
const REFRESH = "mkr_mock_refresh_000000000000001";
const USER = { id: 1, username: "mock", display_name: "Mock User" };
const SCOPES = "market.plans.read market.subscription.read market.subscription.purchase market.subscription.token.read";
const TOKEN_PREFIX = "sk-mock-";

const TIERS = [
  { code: "t5", base: 5 },
  { code: "t20", base: 20 },
  { code: "t50", base: 50 },
  { code: "t100", base: 100 },
];
const PERIODS = [
  { period: "month", months: 1, discount: 0, days: 30 },
  { period: "quarter", months: 3, discount: 10, days: 90 },
  { period: "year", months: 12, discount: 20, days: 365 },
];
const MODELS = ["claude-sonnet-4-5", "gpt-5.2", "gemini-2.5-pro"];
const PLANS = TIERS.flatMap((tier, tierIndex) => PERIODS.map((entry, periodIndex) => ({
  plan_code: `${tier.code}-${entry.period[0]}`,
  tier_code: tier.code,
  title: `TK1688 API · ${tier.base} · ${entry.period}`,
  billing_period: entry.period,
  months: entry.months,
  price_usd: Math.round(tier.base * entry.months * (1 - entry.discount / 100) * 100) / 100,
  list_price_usd: tier.base * entry.months,
  discount_percent: entry.discount,
  currency: "USD",
  token_quota: tier.base * 500_000 * entry.months,
  quota_usd: tier.base * entry.months,
  days: entry.days,
  models: MODELS,
  payment_methods: ["epay", "balance"],
  sort_order: tierIndex * 10 + periodIndex,
})));

const codes = new Map();
const orders = new Map();
const subscriptions = new Map();
const refreshTokens = new Set([REFRESH]);
const base = `http://127.0.0.1:${PORT}`;

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};
const html = (response, status, body) => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
};
const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
});
const bearer = (request) => {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
};
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const id = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const token = () => `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;

function subscriptionFor(planCode) {
  const plan = PLANS.find((candidate) => candidate.plan_code === planCode);
  if (!plan) return null;
  const subscriptionId = id("sub");
  const subscription = {
    subscription_id: subscriptionId, plan_code: plan.plan_code, plan_title: plan.title, status: "active",
    started_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + plan.days * 86_400,
    quota_total: plan.token_quota, quota_used: 0, quota_remaining: plan.token_quota, models: plan.models,
    token: { id: 9001, masked: "sk-mock-****", created_at: Math.floor(Date.now() / 1000) },
    revealed: false,
  };
  subscriptions.set(subscriptionId, subscription);
  return subscription;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, base);
  const path = url.pathname;

  if (request.method === "GET" && path === "/oauth/authorize") {
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    if (url.searchParams.get("client_id") !== "dexbot-desktop" || !redirect.startsWith("http://127.0.0.1:")) {
      return html(response, 400, "<p>Unknown client or redirect.</p>");
    }
    const fields = ["state", "code_challenge", "redirect_uri", "scope"].map((name) => `<input type="hidden" name="${name}" value="${url.searchParams.get(name) ?? ""}">`).join("");
    return html(response, 200, `<!doctype html><meta charset="utf-8"><title>TK1688 mock sign-in</title>
      <body style="font:16px system-ui;max-width:32rem;margin:4rem auto">
      <h1>TK1688 mock</h1><p>Sign in as ${USER.display_name}. This page exists only for local Luna Bot development.</p>
      <form action="/oauth/approve" method="get">${fields}<button style="font:inherit;padding:.6rem 1rem">Authorize</button></form>
      </body>`);
  }

  if (request.method === "GET" && path === "/oauth/approve") {
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    if (!redirect.startsWith("http://127.0.0.1:")) return html(response, 400, "<p>Unknown redirect.</p>");
    const code = id("code");
    codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect });
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    response.writeHead(302, { location: back.href, "cache-control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "POST" && path === "/api/market/oauth/token") {
    const body = new URLSearchParams(await readBody(request));
    if (body.get("grant_type") === "authorization_code") {
      const entry = codes.get(body.get("code"));
      if (!entry || entry.challenge !== challengeOf(body.get("code_verifier") ?? "")) return json(response, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
      codes.delete(body.get("code"));
      return json(response, 200, { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH, scope: SCOPES, user: USER });
    }
    if (body.get("grant_type") === "refresh_token") {
      const presented = body.get("refresh_token");
      if (!refreshTokens.has(presented)) return json(response, 400, { error: "invalid_grant", error_description: "Refresh token was already used." });
      return json(response, 200, { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: presented, scope: SCOPES, user: USER });
    }
    return json(response, 400, { error: "invalid_request" });
  }

  if (request.method === "POST" && path === "/api/market/oauth/revoke") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET" && path === "/api/market/plans") {
    return json(response, 200, { contract_version: 1, plans: PLANS });
  }

  if (path.startsWith("/pay/")) {
    const checkoutId = path.slice("/pay/".length);
    const order = orders.get(checkoutId);
    if (!order) return html(response, 404, "<p>Unknown checkout.</p>");
    if (order.status === "pending_payment") {
      order.status = "active";
      order.subscription = subscriptionFor(order.plan_code);
    }
    return html(response, 200, `<!doctype html><meta charset="utf-8"><title>Paid</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto">
      <h1>Payment complete</h1><p>The mock opened and settled this checkout. Return to Luna Bot; the card updates by itself.</p></body>`);
  }

  if (!url.pathname.startsWith("/v1/") && bearer(request) !== ACCESS) {
    return json(response, 401, { error: { code: "unauthorized", message: "Sign in first.", request_id: id("req") } });
  }

  if (request.method === "GET" && path.startsWith("/api/market/checkout/")) {
    const order = orders.get(path.slice("/api/market/checkout/".length));
    if (!order) return json(response, 404, { error: { code: "checkout_not_found", message: "No such checkout.", request_id: id("req") } });
    return json(response, 200, {
      checkout_id: order.checkout_id, status: order.status, expires_at: order.expires_at,
      ...(order.subscription ? { subscription_id: order.subscription.subscription_id, paid_at: order.paid_at } : {}),
    });
  }

  if (request.method === "POST" && path === "/api/market/checkout") {
    const body = JSON.parse(await readBody(request));
    const plan = PLANS.find((candidate) => candidate.plan_code === body.plan_code);
    if (!plan) return json(response, 409, { error: { code: "plan_unavailable", message: "Unknown plan.", request_id: id("req") } });
    const checkoutId = id("chk");
    const order = { checkout_id: checkoutId, plan_code: plan.plan_code, status: "pending_payment", created_at: Date.now(), expires_at: Math.floor(Date.now() / 1000) + 900 };
    orders.set(checkoutId, order);
    return json(response, 200, { checkout_id: checkoutId, status: order.status, url: `${base}/pay/${checkoutId}?ticket=mock`, expires_at: order.expires_at });
  }

  if (request.method === "GET" && path === "/api/market/subscriptions") {
    return json(response, 200, { contract_version: 1, subscriptions: [...subscriptions.values()].map(({ revealed: _revealed, ...subscription }) => subscription) });
  }

  const revealMatch = /^\/api\/market\/subscriptions\/([^/]+)\/token(?:\/(rotate))?$/.exec(path);
  if (request.method === "POST" && revealMatch) {
    const subscription = subscriptions.get(decodeURIComponent(revealMatch[1]));
    if (!subscription) return json(response, 404, { error: { code: "subscription_not_found", message: "No such subscription.", request_id: id("req") } });
    if (!revealMatch[2] && subscription.revealed) {
      return json(response, 409, { error: { code: "token_already_revealed", message: "Already shown; rotate instead.", request_id: id("req") } });
    }
    subscription.revealed = true;
    return json(response, 200, { token: token(), token_id: 9001, expires_at: subscription.expires_at, models: subscription.models });
  }

  if (request.method === "GET" && path === "/v1/models") {
    return json(response, 200, { object: "list", data: MODELS.map((model) => ({ id: model, object: "model" })) });
  }

  if (request.method === "POST" && path === "/v1/chat/completions") {
    const body = JSON.parse(await readBody(request));
    if (body.stream === false) {
      return json(response, 200, {
        id: "chatcmpl-mock", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Hello from the TK1688 mock." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 },
      });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the TK1688 mock." }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }

  json(response, 404, { error: { code: "not_found", message: "No route.", request_id: id("req") } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`TK1688 market mock: ${base}`);
  console.log(`  LUNABOT_MARKET_FIXTURE=${base} LUNABOT_MARKET_API_FIXTURE=${base} electron . --omb-company-desktop=1`);
});
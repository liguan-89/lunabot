#!/usr/bin/env node
// End-to-end check for the TK1688 market client: OAuth sign-in, plan, checkout,
// subscription, key reveal, then the issued key against /v1/models and chat.
// Requires either the dev mock (scripts/mock-market-api.mjs) or a local backend
// with the dexbot-desktop OAuth client registered. Never touches production.
import { createMarketClient } from "../electron/market-client.mjs";

const env = process.env;
const base = env.MARKET_E2E_BASE;
const api = env.MARKET_E2E_API || base;
const clientId = env.MARKET_E2E_CLIENT_ID || "dexbot-desktop";
const cookie = env.MARKET_E2E_COOKIE || "";
const planCode = env.MARKET_E2E_PLAN || "t20-m";
const payment = env.MARKET_E2E_PAYMENT || "balance";
const mock = env.MARKET_E2E_MOCK === "1";
const autoPay = env.MARKET_E2E_AUTOPAY === "1" || mock;
const wantedModel = env.MARKET_E2E_MODEL || "";
const timeoutMs = Number(env.MARKET_E2E_TIMEOUT_MS || 10 * 60_000);

if (!base) {
  console.error("Set MARKET_E2E_BASE (for example http://127.0.0.1:4010 or https://staging.tk1688.com).");
  process.exit(1);
}
const baseUrl = new URL(base);
const fixture = baseUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname);
if (!fixture && baseUrl.protocol !== "https:") {
  console.error("MARKET_E2E_BASE must be HTTPS, or HTTP loopback for the dev mock.");
  process.exit(1);
}

const decode = (value) => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#34;", '"');
const hiddenInputs = (html) => {
  const fields = {};
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (name) fields[decode(name)] = decode(value);
  }
  return fields;
};

async function authorize(authorizeUrl) {
  const expected = new URL(authorizeUrl).searchParams.get("state");
  const headers = { accept: "text/html", ...(cookie ? { cookie } : {}) };
  const page = await fetch(authorizeUrl, { headers, redirect: "manual" });
  const html = await page.text();
  const form = /<form\b([^>]*)>/i.exec(html)?.[1] ?? "";
  const action = /\baction="([^"]*)"/i.exec(form)?.[1];
  const method = (/\bmethod="([^"]*)"/i.exec(form)?.[1] ?? "get").toLowerCase();
  let location;

  if (action) {
    // Older/simple authorize pages (the dev mock) post a normal form.
    const fields = { ...hiddenInputs(html), decision: "allow" };
    const target = new URL(action, base);
    let response;
    if (method === "post") {
      response = await fetch(target, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        redirect: "manual",
      });
    } else {
      for (const [name, value] of Object.entries(fields)) target.searchParams.set(name, value);
      response = await fetch(target, { headers, redirect: "manual" });
    }
    location = response.headers.get("location");
    if (!location) {
      const detail = (await response.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(`TK1688 consent did not redirect (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
    }
  } else {
    // Real tk1688: /oauth/authorize is a shell that exchanges the refresh cookie
    // for an access token, then calls the JSON info/consent endpoints with Bearer.
    if (!cookie) throw new Error("This tk1688 needs MARKET_E2E_COOKIE (the signed-in browser session).");
    const refresh = await fetch(new URL("/api/user/auth/refresh", base), {
      method: "POST", headers: { cookie, accept: "application/json" }, redirect: "error",
    });
    const refreshed = await refresh.json().catch(() => null);
    const access = refreshed?.data?.access_token;
    if (!refresh.ok || !access) {
      throw new Error("The browser session in MARKET_E2E_COOKIE is not signed in (refresh failed).");
    }
    const params = new URL(authorizeUrl).searchParams;
    const info = await fetch(new URL(`/api/market/oauth/authorize/info?${params}`, base), {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" }, redirect: "error",
    });
    const details = await info.json().catch(() => null);
    if (!info.ok) throw new Error(`TK1688 authorize info failed: ${details?.error?.message ?? info.status}`);
    const fields = {};
    for (const [name, value] of params) fields[name] = value;
    fields.exp = String(details.exp);
    fields.sig = details.sig;
    fields.decision = "allow";
    const consent = await fetch(new URL("/api/market/oauth/authorize/consent", base), {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, cookie, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "error",
    });
    const answer = await consent.json().catch(() => null);
    if (!consent.ok || !answer?.redirect_url) {
      throw new Error(`TK1688 consent failed: ${answer?.error?.message ?? consent.status}`);
    }
    location = answer.redirect_url;
  }

  const callback = new URL(location);
  if (callback.hostname !== "127.0.0.1" && callback.hostname !== "[::1]") throw new Error("Refusing a non-loopback OAuth callback.");
  if (callback.searchParams.get("state") !== expected) throw new Error("OAuth state mismatch on the callback.");
  if (callback.searchParams.get("error")) throw new Error(`TK1688 refused the authorization: ${callback.searchParams.get("error")}`);
  const done = await fetch(callback, { redirect: "manual" });
  if (!done.ok) throw new Error(`The loopback callback answered HTTP ${done.status}.`);
}

const store = (() => {
  let saved = null;
  return { read: async () => saved, write: async (value) => { saved = value; } };
})();

const client = createMarketClient({
  store,
  openBrowser: authorize,
  origin: base,
  apiOrigin: api,
  clientId,
  fixture,
  waitMs: 120_000,
});

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, redirect: "error" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${body?.error?.message ?? body?.error?.code ?? ""}`.trim());
  return body;
}

async function main() {
  console.log(`TK1688 E2E: ${base} / plan ${planCode} / ${payment}${mock ? " / mock" : ""}`);
  await client.start();
  await client.signIn();
  console.log("✓ OAuth sign-in");

  const { plans } = await client.plans();
  const plan = plans.find((entry) => entry.plan_code === planCode) ?? plans[0];
  if (!plan) throw new Error("No plans returned.");
  console.log(`✓ plans: ${plans.length} SKUs; using ${plan.plan_code} (${plan.billing_period})`);

  const checkout = await client.checkout(plan.plan_code, payment);
  let subscriptionId = checkout.subscription_id;
  if (checkout.status !== "active") {
    console.log(`… checkout ${checkout.checkout_id}; pay here: ${checkout.url}`);
    if (autoPay) {
      await fetch(checkout.url);
      console.log("… mock payment page opened");
    }
    const status = await client.waitForCheckout(checkout.checkout_id, { intervalMs: 2_000, timeoutMs });
    if (status.status !== "active") throw new Error(`Checkout ended as ${status.status}.`);
    subscriptionId = status.subscription_id;
  }
  if (!subscriptionId) {
    // Balance settles inside checkout and the response may omit the new id.
    const { subscriptions } = await client.subscriptions();
    const live = subscriptions
      .filter((entry) => entry.status === "active" || entry.status === "expiring")
      .sort((left, right) => right.expires_at - left.expires_at);
    subscriptionId = (live.find((entry) => entry.plan_code === plan.plan_code) ?? live[0])?.subscription_id;
  }
  if (!subscriptionId) throw new Error("Checkout did not name a subscription.");
  console.log(`✓ checkout active → ${subscriptionId}`);

  const { subscriptions } = await client.subscriptions();
  const subscription = subscriptions.find((entry) => entry.subscription_id === subscriptionId)
    ?? subscriptions.find((entry) => entry.plan_code === plan.plan_code);
  if (!subscription) throw new Error("Subscription list does not contain the new subscription.");
  console.log(`✓ subscription ${subscription.status}; ${subscription.quota_remaining}/${subscription.quota_total} quota; ends ${new Date(subscription.expires_at * 1000).toISOString()}`);

  let revealed;
  try {
    revealed = await client.revealToken(subscription.subscription_id);
  } catch (error) {
    if (error?.code !== "token_already_revealed") throw error;
    revealed = await client.rotateToken(subscription.subscription_id);
  }
  console.log(`✓ key revealed (token id ${revealed.token_id}, ${revealed.models.length} models)`);

  const models = await fetchJson(new URL("/v1/models", api), {
    headers: { authorization: `Bearer ${revealed.token}`, accept: "application/json" },
  });
  const ids = Array.isArray(models?.data) ? models.data.map((row) => row?.id).filter(Boolean) : [];
  const model = wantedModel || ids[0];
  if (!model) throw new Error("The issued key returned no models.");
  console.log(`✓ /v1/models: ${ids.length} models; using ${model}`);

  const completion = await fetchJson(new URL("/v1/chat/completions", api), {
    method: "POST",
    headers: { authorization: `Bearer ${revealed.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the word OK." }], max_tokens: 16, stream: false }),
  });
  const reply = completion?.choices?.[0]?.message?.content ?? "";
  if (!reply) throw new Error("Chat completion returned no message.");
  console.log(`✓ chat: ${reply.slice(0, 80).replace(/\s+/g, " ")}`);

  console.log("E2E OK");
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}`);
  process.exitCode = 1;
});
import { grantFor, sessionPayload } from "./accounts.js";
import {
  cleanDeviceName,
  cleanEmail,
  cleanPlatform,
  cleanVersion,
  isCloudId,
  newUserCode,
  randomBytesB64u,
  sha256Hex,
} from "./crypto.js";
import {
  CHECKOUT_SOURCES,
  PLANS,
  UPGRADE_SOURCES,
  grantSession,
  publicConfig,
  rateLimit,
  sendOtp,
  sessions,
  validPlan,
  verifyOtp,
} from "./helpers.js";
import { HttpError, json } from "./http.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_CODE_TTL_S = 900;
const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const CONSENT_STATUSES = new Set(["opted_in", "declined", "withdrawn"]);
const CONSENT_VERSION = /^[0-9a-z][0-9a-z.-]{0,39}$/;
const UPGRADE_TIERS = new Set(["starter", "personal", "pro", "max"]);

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

export async function handleAdmin(ctx) {
  for (const entry of routes) {
    if (entry.method !== ctx.method) continue;
    const match = typeof entry.pattern === "string" ? (ctx.path === entry.pattern ? [] : null) : ctx.path.match(entry.pattern);
    if (!match) continue;
    await entry.handler(ctx, match);
    return true;
  }
  return false;
}

route("POST", "/api/cloud/desktop/authorize", async (ctx) => {
  const name = cleanDeviceName(ctx.body.deviceName);
  const platform = cleanPlatform(ctx.body.platform);
  const appVersion = cleanVersion(ctx.body.appVersion);
  if (!name || !platform) throw new HttpError(400, "invalid_request");
  rateLimit(ctx, ctx.limits.authorizeIp, `authorize:${ctx.ip}`);
  const deviceCode = randomBytesB64u(32);
  const userCode = newUserCode();
  ctx.store.insertDeviceCode({
    codeHash: sha256Hex(deviceCode),
    userCode,
    deviceName: name,
    platform,
    appVersion,
    expiresAt: Date.now() + DEVICE_CODE_TTL_S * 1000,
  });
  json(ctx.res, 200, {
    cloudContractVersion: 1,
    deviceCode,
    userCode,
    verificationUriComplete: `${ctx.config.origin}/cloud/desktop?code=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_CODE_TTL_S,
    interval: 5,
  });
});

route("POST", "/api/cloud/desktop/token", async (ctx) => {
  const deviceCode = ctx.body.deviceCode;
  if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deviceCode)) throw new HttpError(400, "invalid_grant");
  rateLimit(ctx, ctx.limits.tokenIp, `token:${ctx.ip}`);
  const row = ctx.store.deviceCodeByHash(sha256Hex(deviceCode));
  if (!row || Number(row.expires_at) <= Date.now()) throw new HttpError(400, "expired_token");
  if (row.redeemed_at) throw new HttpError(400, "invalid_grant");
  if (!row.approved_at) throw new HttpError(400, "authorization_pending");
  const account = ctx.store.accountById(row.account_id);
  if (!account) throw new HttpError(400, "invalid_grant");
  const session = grantSession(ctx, account, row.device_name, row.platform, row.app_version);
  ctx.store.redeemDeviceCode(row.code_hash);
  json(ctx.res, 200, grantFor(account, session.deviceId, { token: session.token, expiresAt: session.expiresAt }));
});

route("GET", "/api/cloud/desktop/session", async (ctx) => {
  const session = sessions(ctx);
  json(ctx.res, 200, sessionPayload(ctx.store, ctx.config, session));
});

route("DELETE", "/api/cloud/desktop/session", async (ctx) => {
  const session = sessions(ctx);
  ctx.store.revokeSession(session.token_hash);
  json(ctx.res, 200, {});
});

route("POST", "/api/cloud/app/sign-in/start", async (ctx) => {
  const email = cleanEmail(ctx.body.email);
  const deviceName = cleanDeviceName(ctx.body.deviceName);
  const platform = cleanPlatform(ctx.body.platform);
  const appVersion = cleanVersion(ctx.body.appVersion);
  if (!email || !deviceName || !platform) throw new HttpError(400, "invalid_request");
  const attempt = await sendOtp(ctx, { email, purpose: "admin", deviceName, platform, appVersion });
  json(ctx.res, 200, {
    cloudContractVersion: 1,
    attempt,
    expiresIn: ctx.config.otpTtlSeconds,
    resendAfter: ctx.config.otpResendSeconds,
    signupOpen: ctx.config.signupOpen,
  });
});

route("POST", "/api/cloud/app/sign-in/verify", async (ctx) => {
  const { account, row } = await verifyOtp(ctx, { attempt: ctx.body.attempt, code: ctx.body.code, purpose: "admin" });
  const session = grantSession(ctx, account, row.device_name, row.platform, row.app_version);
  json(ctx.res, 200, grantFor(account, session.deviceId, { token: session.token, expiresAt: session.expiresAt }));
});

route("POST", "/api/cloud/desktop/approve/start", async (ctx) => {
  const userCode = String(ctx.body.userCode ?? "").trim().toUpperCase();
  if (!/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(userCode)) throw new HttpError(400, "invalid_request");
  const deviceCode = ctx.store.deviceCodeByUserCode(userCode);
  if (!deviceCode) throw new HttpError(404, "not_found");
  if (deviceCode.approved_at) throw new HttpError(409, "already_approved");
  if (Number(deviceCode.expires_at) <= Date.now()) throw new HttpError(410, "expired");
  const attempt = await sendOtp(ctx, { email: ctx.body.email, purpose: "approval", userCode });
  json(ctx.res, 200, { attempt });
});

route("POST", "/api/cloud/desktop/approve/verify", async (ctx) => {
  const { account, row } = await verifyOtp(ctx, { attempt: ctx.body.attempt, code: ctx.body.code, purpose: "approval" });
  const deviceCode = row.user_code ? ctx.store.deviceCodeByUserCode(row.user_code) : null;
  if (!deviceCode) throw new HttpError(404, "not_found");
  if (Number(deviceCode.expires_at) <= Date.now()) throw new HttpError(410, "expired");
  ctx.store.approveDeviceCode(deviceCode.code_hash, account.id);
  json(ctx.res, 200, { ok: true });
});

route("GET", "/api/public/config", async (ctx) => {
  json(ctx.res, 200, publicConfig());
});

route("POST", "/api/cloud/desktop/checkout", async (ctx) => {
  const session = sessions(ctx);
  const plan = ctx.body.plan;
  const source = String(ctx.body.source ?? "");
  if (!validPlan(plan)) throw new HttpError(400, "invalid_request");
  if (!CHECKOUT_SOURCES.has(source)) throw new HttpError(400, "invalid_request");
  rateLimit(ctx, ctx.limits.checkoutIp, `checkout:${ctx.ip}`);
  const checkout = ctx.store.insertCheckout({
    id: `co_${randomBytesB64u(16)}`,
    accountId: session.account_id,
    plan,
    source,
    expiresAt: Date.now() + CHECKOUT_TTL_MS,
  });
  json(ctx.res, 200, { cloudContractVersion: 1, url: `${ctx.config.origin}/pro/buy?checkout=${encodeURIComponent(checkout.id)}` });
});

route("POST", "/api/cloud/desktop/upgrade/preview", async (ctx) => {
  const session = sessions(ctx);
  const plan = ctx.body.plan;
  if (!UPGRADE_TIERS.has(plan) || !UPGRADE_SOURCES.has(String(ctx.body.source ?? ""))) throw new HttpError(400, "invalid_request");
  ctx.store.updatePlan(session.account_id, { tier: plan, status: "active", expiresAt: Date.now() + 30 * DAY_MS });
  json(ctx.res, 200, { cloudContractVersion: 1, status: "upgraded", tier: plan });
});

route("POST", "/api/cloud/desktop/upgrade", async (ctx) => {
  const session = sessions(ctx);
  const plan = ctx.body.plan;
  if (!UPGRADE_TIERS.has(plan) || !UPGRADE_SOURCES.has(String(ctx.body.source ?? ""))) throw new HttpError(400, "invalid_request");
  ctx.store.updatePlan(session.account_id, { tier: plan, status: "active", expiresAt: Date.now() + 30 * DAY_MS });
  json(ctx.res, 200, { cloudContractVersion: 1, status: "upgraded", tier: plan });
});

route("POST", "/api/cloud/desktop/feedback", async (ctx) => {
  sessions(ctx);
  json(ctx.res, 200, {});
});

route("POST", "/api/cloud/desktop/room", async (ctx) => {
  sessions(ctx);
  json(ctx.res, 200, {});
});

route("POST", "/api/cloud/desktop/resize-now", async (ctx) => {
  sessions(ctx);
  json(ctx.res, 200, { state: "current" });
});

route("POST", "/api/cloud/desktop/interest", async (ctx) => {
  sessions(ctx);
  json(ctx.res, 200, { ok: true });
});

route("POST", "/api/cloud/desktop/wake", async (ctx) => {
  sessions(ctx);
  json(ctx.res, 200, { state: "awake" });
});

route("POST", "/api/cloud/desktop/disk", async (ctx) => {
  sessions(ctx);
  const requested = Number(ctx.body.sizeGb);
  const gb = Number.isSafeInteger(requested) && requested >= 1 && requested <= 100 ? requested : 20;
  json(ctx.res, 200, { disk: { gb, maxGb: 100 } });
});

route("POST", "/api/cloud/desktop/pairing", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", /^\/api\/cloud\/desktop\/teams\/[A-Za-z0-9._-]{1,128}\/pairing$/, async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/desktop/export", async (ctx) => {
  sessions(ctx);
  throw new HttpError(409, "notHeld");
});

route("POST", "/api/cloud/desktop/moved", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/desktop/kept", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/desktop/moved-to", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/desktop/move-status", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/desktop/services/x", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_offered");
});

route("POST", "/api/cloud/desktop/services/pages", async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_offered");
});

route("GET", "/api/cloud/desktop/updates-consent", async (ctx) => {
  const session = sessions(ctx);
  const consent = ctx.store.consent(session.account_id);
  json(ctx.res, 200, {
    cloudContractVersion: 1,
    consent: consent ? { status: consent.status, textVersion: consent.text_version } : null,
  });
});

route("POST", "/api/cloud/desktop/updates-consent", async (ctx) => {
  const session = sessions(ctx);
  const status = ctx.body.status;
  const textVersion = ctx.body.textVersion;
  if (!CONSENT_STATUSES.has(status) || typeof textVersion !== "string" || !CONSENT_VERSION.test(textVersion)) {
    throw new HttpError(400, "invalid_request");
  }
  ctx.store.setConsent(session.account_id, status, textVersion);
  json(ctx.res, 200, { cloudContractVersion: 1, consent: { status, textVersion } });
});

route("POST", "/api/updates-consent", async () => {
  throw new HttpError(404, "unknown_receipt");
});

route("POST", "/api/cloud/desktop/clouds", async (ctx) => {
  sessions(ctx);
  throw new HttpError(409, "signups_closed", { addBlocked: "signups_closed" });
});

route("POST", "/api/cloud/desktop/organizations", async (ctx) => {
  sessions(ctx);
  throw new HttpError(403, "blocked", { blocked: "off" });
});

route("PATCH", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}$/, async (ctx) => {
  sessions(ctx);
  if (!isCloudId(ctx.path.split("/").at(-1))) throw new HttpError(400, "invalid_request");
  throw new HttpError(404, "not_found");
});

route("POST", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}\/hide$/, async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}\/cancel$/, async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}\/keep$/, async (ctx) => {
  sessions(ctx);
  throw new HttpError(404, "not_found");
});

route("POST", "/api/cloud/checkout/create", async (ctx) => {
  const plan = ctx.body.plan;
  if (!validPlan(plan)) throw new HttpError(400, "invalid_request");
  rateLimit(ctx, ctx.limits.checkoutIp, `checkout:${ctx.ip}`);
  const checkout = ctx.store.insertCheckout({
    id: `co_${randomBytesB64u(16)}`,
    plan,
    source: "web",
    expiresAt: Date.now() + CHECKOUT_TTL_MS,
  });
  json(ctx.res, 200, { url: `${ctx.config.origin}/pro/buy?checkout=${encodeURIComponent(checkout.id)}` });
});

route("POST", "/api/cloud/checkout/start", async (ctx) => {
  const checkout = ctx.store.checkout(String(ctx.body.checkoutId ?? ""));
  if (!checkout || checkout.status !== "open" || Number(checkout.expires_at) <= Date.now()) throw new HttpError(410, "expired");
  const attempt = await sendOtp(ctx, { email: ctx.body.email, purpose: "checkout", checkoutId: checkout.id });
  json(ctx.res, 200, { attempt });
});

route("POST", "/api/cloud/checkout/verify", async (ctx) => {
  const { account, row } = await verifyOtp(ctx, { attempt: ctx.body.attempt, code: ctx.body.code, purpose: "checkout" });
  const checkout = ctx.store.checkout(String(row.checkout_id ?? ""));
  if (!checkout || checkout.status !== "open" || Number(checkout.expires_at) <= Date.now()) throw new HttpError(410, "expired");
  ctx.store.updatePlan(account.id, { tier: checkout.plan, status: "active", expiresAt: Date.now() + 30 * DAY_MS });
  ctx.store.completeCheckout(checkout.id, account.id);
  json(ctx.res, 200, { ok: true });
});

export function adminPlans() {
  return PLANS;
}

import { codeMatches, createAccount, issueSession, newEmailAttempt } from "./accounts.js";
import { cleanEmail, isPlanTier, randomBytesB64u, sha256Hex } from "./crypto.js";
import { HttpError, bearer } from "./http.js";

export const PLANS = [
  { tier: "starter", name: "Starter", priceUsd: 9, note: "一台常驻云电脑，适合轻量自动化。" },
  { tier: "personal", name: "Personal", priceUsd: 19, note: "更大的内存与磁盘，个人日常使用。" },
  { tier: "pro", name: "Pro", priceUsd: 39, note: "多 Bot 并行、更多并发任务。" },
  { tier: "max", name: "Max", priceUsd: 89, note: "最高配置，适合团队与重负载。" },
];

export const CHECKOUT_SOURCES = new Set([
  "app_card", "app_howto", "app_menu", "app_settings", "app_routines", "app_pages",
  "app_whats_new_pro", "app_whats_new_team", "app_onboarding",
]);

export const UPGRADE_SOURCES = new Set(["app_usage", "app_settings", "app_room"]);

export const planFor = (tier) => PLANS.find((plan) => plan.tier === tier) ?? null;

export function publicConfig() {
  return {
    plans: PLANS.map((plan) => ({
      tier: plan.tier,
      price: { currency: "USD", interval: "month", amount: plan.priceUsd * 100 },
      trialDays: 7,
      label: plan.name,
    })),
    trialDays: 7,
    trial: { days: 7, creditUsd: 0, reminderDays: 2 },
    refundDays: 14,
  };
}

export function sessions(ctx) {
  const token = bearer(ctx.req);
  const session = ctx.store.sessionByTokenHash(sha256Hex(token ?? ""));
  if (!session || Number(session.expires_at) <= Date.now()) {
    if (session) ctx.store.revokeSession(session.token_hash);
    throw new HttpError(401, "invalid_token");
  }
  ctx.store.touchDevice(session.device_id);
  return session;
}

export function controlSession(ctx) {
  const token = bearer(ctx.req);
  const session = ctx.store.controlSessionByTokenHash(sha256Hex(token ?? ""));
  if (!session || Number(session.expires_at) <= Date.now()) {
    if (session) ctx.store.revokeControlSession(session.token_hash);
    throw new HttpError(401, "invalid_token");
  }
  return session;
}

export function installationAuth(ctx) {
  const token = bearer(ctx.req);
  const credential = ctx.store.installationCredentialByTokenHash(sha256Hex(token ?? ""));
  if (!credential || Number(credential.expires_at) <= Date.now()) {
    if (credential) ctx.store.revokeInstallationCredentials(credential.installation_id);
    throw new HttpError(401, "invalid_token");
  }
  ctx.store.touchInstallation(credential.installation_id);
  return credential;
}

export function rateLimit(ctx, limiter, key) {
  if (!limiter.check(key)) throw new HttpError(429, "rate_limited", { retryAfter: 60 });
}

export function otpEmailAvailable(ctx, email) {
  if (ctx.config.signupOpen) return true;
  return Boolean(ctx.store.accountByEmail(email));
}

export async function sendOtp(ctx, { email, purpose, userCode = null, checkoutId = null, deviceName = null, platform = null, appVersion = null }) {
  const clean = cleanEmail(email);
  if (!clean) throw new HttpError(400, "invalid_request");
  if (!otpEmailAvailable(ctx, clean)) throw new HttpError(403, "signup_closed");
  rateLimit(ctx, ctx.limits.otpIp, `otp:ip:${ctx.ip}`);
  rateLimit(ctx, ctx.limits.otpEmail, `otp:email:${clean}`);
  if (ctx.store.countEmailAttempts(clean, Date.now() - 15 * 60_000) >= 5) throw new HttpError(429, "rate_limited", { retryAfter: 300 });

  const attempt = newEmailAttempt(ctx.config, { email: clean, purpose, userCode, checkoutId, deviceName, platform, appVersion });
  ctx.store.insertEmailAttempt({
    attemptHash: attempt.attemptHash,
    email: clean,
    codeHash: attempt.codeHash,
    purpose,
    userCode,
    checkoutId,
    deviceName,
    platform,
    appVersion,
    expiresAt: attempt.expiresAt,
  });
  await ctx.emailer({
    to: clean,
    subject: "Luna Bot 登录码",
    text: `你的 Luna Bot 登录码是 ${attempt.code}\n\n10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
  });
  return attempt.attempt;
}

export async function verifyOtp(ctx, { attempt, code, purpose, email = null }) {
  const provided = String(code ?? "").replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(provided)) throw new HttpError(400, "invalid_code");
  let row = null;
  if (attempt !== undefined) {
    if (typeof attempt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(attempt)) throw new HttpError(400, "invalid_code");
    row = ctx.store.emailAttempt(sha256Hex(attempt));
  } else if (email) {
    const clean = cleanEmail(email);
    row = clean ? ctx.store.latestEmailAttempt(clean, purpose) : null;
  }
  if (!row || row.purpose !== purpose) throw new HttpError(410, "expired");
  if (row.consumed_at || Number(row.expires_at) <= Date.now() || Number(row.attempts) >= 5) throw new HttpError(410, "expired");
  if (!codeMatches(ctx.config, row.email, row.purpose, row.code_hash, provided)) {
    ctx.store.recordEmailFailure(row.attempt_hash);
    throw new HttpError(400, "invalid_code");
  }
  ctx.store.consumeEmailAttempt(row.attempt_hash);
  const account = ctx.store.accountByEmail(row.email) ?? (ctx.config.signupOpen ? createAccount(ctx.store, ctx.config, row.email) : null);
  if (!account) throw new HttpError(403, "signup_closed");
  return { account, row };
}

export function grantSession(ctx, account, deviceName, platform, appVersion) {
  const device = ctx.store.insertDevice({
    id: `dev_${randomBytesB64u(16)}`,
    accountId: account.id,
    name: deviceName || "Luna Bot",
    platform: platform || "linux",
    appVersion: appVersion || "0.0.0",
  });
  const session = issueSession(ctx.store, ctx.config, account.id, device.id);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    deviceId: device.id,
    account,
  };
}

export function validPlan(value) {
  return isPlanTier(value) && Boolean(planFor(value));
}

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

/** A paid account with no Cloud gets its first one on sign-in, as the desktop's setup card expects. Once only;
 * a failed first attempt is not retried behind the person's back. */
function ensureDefaultCloud(ctx, account) {
  if (!account || !ctx.provisioner || account.plan_status !== "active" || Number(account.plan_expires_at) <= Date.now()) return;
  const live = ctx.store.cloudsFor(account.id).filter((cloud) => cloud.status !== "ended");
  if (live.length || !ctx.store.claimAutoCloud(account.id)) return;
  void ctx.provisioner.create({ accountId: account.id, tier: account.plan_tier, name: "My Cloud", color: "blue" })
    .catch((error) => ctx.log(`auto cloud for ${account.id} failed: ${error?.message ?? error}`));
}

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
  ensureDefaultCloud(ctx, account);
  json(ctx.res, 200, grantFor(account, session.deviceId, { token: session.token, expiresAt: session.expiresAt }));
});

route("GET", "/api/cloud/desktop/session", async (ctx) => {
  const session = sessions(ctx);
  ensureDefaultCloud(ctx, ctx.store.accountById(session.account_id));
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
  ensureDefaultCloud(ctx, account);
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

function ownCloud(ctx, session, id = null) {
  if (id) {
    if (!isCloudId(id)) return null;
    const cloud = ctx.store.cloud(id);
    return cloud && cloud.account_id === session.account_id && cloud.status !== "ended" ? cloud : null;
  }
  return ctx.store.cloudsFor(session.account_id).find((cloud) => cloud.role === "owner" && !cloud.team_id && cloud.status !== "ended") ?? null;
}

route("POST", "/api/cloud/desktop/wake", async (ctx) => {
  const session = sessions(ctx);
  const cloud = ownCloud(ctx, session);
  if (!cloud) throw new HttpError(404, "not_found");
  if (cloud.status === "ready") return json(ctx.res, 200, { state: "awake" });
  void ctx.provisioner.start(cloud).catch((error) => ctx.log(`wake ${cloud.id} failed: ${error?.message ?? error}`));
  json(ctx.res, 200, { state: "waking" });
});

route("POST", "/api/cloud/desktop/disk", async (ctx) => {
  const session = sessions(ctx);
  const cloud = ownCloud(ctx, session);
  if (!cloud) throw new HttpError(404, "not_found");
  const maxGb = Number(cloud.max_disk_gb || ctx.config.cloudMaxDiskGb);
  const current = Number(cloud.disk_gb || ctx.config.cloudDiskGb);
  const requested = Number(ctx.body.sizeGb);
  if (Number.isSafeInteger(requested) && requested >= current && requested <= maxGb) {
    ctx.store.updateCloud(cloud.id, { disk_gb: requested });
    return json(ctx.res, 200, { disk: { gb: requested, maxGb } });
  }
  json(ctx.res, 200, { disk: { gb: current, maxGb } });
});

route("POST", "/api/cloud/desktop/pairing", async (ctx) => {
  const session = sessions(ctx);
  const cloud = ownCloud(ctx, session, typeof ctx.body.cloudId === "string" ? ctx.body.cloudId : null);
  if (!cloud) throw new HttpError(404, "not_found");
  try {
    const grant = await ctx.provisioner.pairing(cloud);
    json(ctx.res, 200, { cloudContractVersion: 1, ...grant });
  } catch (error) {
    if (error?.code === "not_running") throw new HttpError(409, "not_running");
    ctx.log(`pairing ${cloud.id} failed: ${error?.message ?? error}`);
    throw new HttpError(502, "pairing_failed");
  }
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

const CLOUD_COLORS = new Set(["blue", "green", "amber", "rose", "violet", "slate"]);

/** The @devs report contract the desktop and Cloud homes send: 10,000 description characters, 40 for appVersion and
 * platform, 262,144 for diagnostics, a 600 KB body. */
const REPORT_LIMITS = { description: 10_000, field: 40, diagnostics: 262_144, installId: /^[A-Za-z0-9._:-]{1,128}$/, ids: 50 };
const REPORT_SOURCES = new Set(["bot", "web"]);

function clipReport(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function reportId() {
  return `br_${randomBytesB64u(16)}`;
}

route("POST", "/api/bug-reports", async (ctx) => {
  rateLimit(ctx, ctx.limits.bugIp, `bug:${ctx.ip}`);
  const installId = typeof ctx.body.installId === "string" ? ctx.body.installId.trim() : "";
  const source = REPORT_SOURCES.has(ctx.body.source) ? ctx.body.source : "web";
  const description = clipReport(ctx.body.description, REPORT_LIMITS.description).trim();
  if (!REPORT_LIMITS.installId.test(installId) || description.length < 1) throw new HttpError(400, "invalid_request");
  const contactEmail = cleanEmail(ctx.body.contactEmail ?? ctx.body.contact) ?? null;
  const report = {
    id: reportId(),
    installId,
    source,
    description,
    appVersion: clipReport(ctx.body.appVersion, REPORT_LIMITS.field).trim() || null,
    platform: clipReport(ctx.body.platform, REPORT_LIMITS.field).trim() || null,
    diagnostics: clipReport(ctx.body.diagnostics, REPORT_LIMITS.diagnostics) || null,
    contactEmail,
  };
  ctx.store.insertBugReport(report);
  ctx.log(`bug report ${report.id} from ${installId} (${source}, ${report.platform ?? "unknown"})`);
  json(ctx.res, 201, { id: report.id });
});

route("POST", "/api/bug-reports/status", async (ctx) => {
  rateLimit(ctx, ctx.limits.bugIp, `bug:${ctx.ip}`);
  const installId = typeof ctx.body.installId === "string" ? ctx.body.installId.trim() : "";
  if (!REPORT_LIMITS.installId.test(installId)) throw new HttpError(400, "invalid_request");
  const ids = Array.isArray(ctx.body.ids)
    ? ctx.body.ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, REPORT_LIMITS.ids)
    : [];
  const reports = ctx.store.bugReportStatuses(installId, ids).map((row) => ({
    id: row.id,
    status: row.status === "fixed" ? "fixed" : row.status === "unknown" ? "unknown" : "received",
    fixedIn: row.fixed_in ?? null,
  }));
  json(ctx.res, 200, { reports, notify: true });
});

/** The admin reading the reports: a signed-in desktop session whose account is listed in LUNABOT_CLOUD_ADMIN_EMAILS. */
function adminSession(ctx) {
  const session = sessions(ctx);
  if (!ctx.config.adminEmails.includes(String(session.account_email ?? "").toLowerCase())) throw new HttpError(403, "forbidden");
  return session;
}

route("GET", "/api/cloud/desktop/admin/bug-reports", async (ctx) => {
  adminSession(ctx);
  const reports = ctx.store.recentBugReports(100).map((row) => ({
    id: row.id,
    installId: row.install_id,
    source: row.source,
    status: row.status,
    fixedIn: row.fixed_in,
    appVersion: row.app_version,
    platform: row.platform,
    contactEmail: row.contact_email,
    description: row.description,
    diagnostics: row.diagnostics,
    createdAt: Number(row.created_at),
  }));
  json(ctx.res, 200, { reports });
});

route("POST", /^\/api\/cloud\/desktop\/admin\/bug-reports\/[A-Za-z0-9_-]{1,64}\/fixed$/, async (ctx) => {
  adminSession(ctx);
  const id = ctx.path.split("/").at(-2);
  const fixedIn = cleanVersion(ctx.body.fixedIn);
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(fixedIn)) throw new HttpError(400, "invalid_request");
  const report = ctx.store.markBugReportFixed(id, fixedIn);
  if (!report) throw new HttpError(404, "not_found");
  json(ctx.res, 200, { id: report.id, status: report.status, fixedIn: report.fixed_in });
});

function cleanCloudName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && [...name].length <= 40 && !/[\p{Cc}<>]/u.test(name) ? name : null;
}

route("POST", "/api/cloud/desktop/clouds", async (ctx) => {
  const session = sessions(ctx);
  if (session.plan_status !== "active" || Number(session.plan_expires_at) <= Date.now()) {
    throw new HttpError(403, "signup_closed", { addBlocked: "signups_closed" });
  }
  const tier = ctx.body.tier;
  const name = cleanCloudName(ctx.body.name);
  const color = ctx.body.color === null || ctx.body.color === undefined ? null : ctx.body.color;
  if (!validPlan(tier) || !name || (color !== null && !CLOUD_COLORS.has(color))) throw new HttpError(400, "invalid_request");
  rateLimit(ctx, ctx.limits.checkoutIp, `checkout:${ctx.ip}`);
  let cloud;
  try {
    cloud = await ctx.provisioner.create({ accountId: session.account_id, tier, name, color });
  } catch (error) {
    if (error?.code === "cloud_cap") throw new HttpError(409, "cap", { addBlocked: "cap" });
    throw error;
  }
  json(ctx.res, 200, {
    cloudContractVersion: 1,
    cloudId: cloud.id,
    checkoutUrl: `${ctx.config.origin}/provision?cloud=${encodeURIComponent(cloud.id)}`,
  });
});

route("POST", "/api/cloud/desktop/organizations", async (ctx) => {
  sessions(ctx);
  throw new HttpError(403, "blocked", { blocked: "off" });
});

route("PATCH", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}$/, async (ctx) => {
  const session = sessions(ctx);
  const id = ctx.path.split("/").at(-1);
  if (!isCloudId(id)) throw new HttpError(400, "invalid_request");
  const cloud = ownCloud(ctx, session, id);
  if (!cloud) throw new HttpError(404, "not_found");
  const color = ctx.body.color;
  if (!(color === null || CLOUD_COLORS.has(color))) throw new HttpError(400, "invalid_request");
  ctx.store.updateCloud(id, { color });
  json(ctx.res, 200, {});
});

route("POST", /^\/api\/cloud\/desktop\/clouds\/[A-Za-z0-9_-]{1,64}\/hide$/, async (ctx) => {
  const session = sessions(ctx);
  const id = ctx.path.split("/").at(-1);
  if (!isCloudId(id)) throw new HttpError(400, "invalid_request");
  const cloud = ownCloud(ctx, session, id);
  if (!cloud) throw new HttpError(404, "not_found");
  ctx.store.hideCloud(id);
  json(ctx.res, 200, {});
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

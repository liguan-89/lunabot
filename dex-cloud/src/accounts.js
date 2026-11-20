import { hmacHex, newEightDigit, randomBytesB64u, randomToken, sha256Hex } from "./crypto.js";

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function newAccountId() {
  return `acct_${randomBytesB64u(16)}`;
}

export function createAccount(store, config, email) {
  const existing = store.accountByEmail(email);
  if (existing) return existing;
  const pro = config.planMode !== "free";
  return store.insertAccount({
    id: newAccountId(),
    email,
    planTier: pro ? "max" : "free",
    planStatus: pro ? "active" : "none",
    planExpiresAt: pro ? Date.now() + TEN_YEARS_MS : null,
  });
}

export function entitlementFor(account, now = Date.now()) {
  const active = account.plan_status === "active" && Number(account.plan_expires_at) > now;
  if (!active) {
    return { plan: "free", status: "none", expiresAt: null, version: Number(account.plan_version ?? 1) };
  }
  return {
    plan: "pro",
    tier: account.plan_tier,
    status: "active",
    expiresAt: Number(account.plan_expires_at),
    version: Number(account.plan_version ?? 1),
  };
}

export function issueSession(store, config, accountId, deviceId) {
  const token = randomToken("omc_");
  const expiresAt = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
  store.insertSession({ id: randomBytesB64u(16), accountId, deviceId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

export function grantFor(account, deviceId, session) {
  return {
    cloudContractVersion: 1,
    accessToken: session.token,
    expiresAt: session.expiresAt,
    device: { id: deviceId },
    account: { id: account.id, email: account.email },
  };
}

export function sessionPayload(store, config, session) {
  const entitlement = entitlementFor({
    plan_tier: session.plan_tier,
    plan_status: session.plan_status,
    plan_expires_at: session.plan_expires_at,
    plan_version: 1,
  });
  const rows = store.cloudsFor(session.account_id).filter((cloud) => cloud.status !== "ended").slice(0, 20);
  const primary = rows.find((cloud) => cloud.role === "owner" && !cloud.team_id) ?? null;
  const clouds = rows.map((cloud) => ({
    id: cloud.id,
    name: cloud.name,
    ...(cloud.color ? { color: cloud.color } : {}),
    role: cloud.role,
    ...(cloud.tier ? { tier: cloud.tier } : {}),
    runsOn: "cloud",
    status: cloud.status,
    ...(cloud.origin ? { origin: cloud.origin } : {}),
    ...(cloud.team_id ? { teamId: cloud.team_id } : {}),
    primary: cloud.id === primary?.id,
    managed: true,
    ...(cloud.status === "setting_up" ? { setup: { step: cloud.setup_step || "reserving", ...(typeof cloud.setup_progress === "number" ? { progress: cloud.setup_progress } : {}) } } : {}),
    ...(Number(cloud.last_seen_at) > 0 ? { lastSeenAt: Number(cloud.last_seen_at) } : {}),
    ...(cloud.version ? { version: cloud.version } : {}),
    removable: false,
    ...(cloud.status === "ready" ? { power: { state: cloud.power_state || "awake", since: Number(cloud.updated_at), sleeps: false } } : {}),
  }));
  const teams = store.teamsFor(session.account_id).slice(0, 50).map((team) => ({
    id: team.id,
    name: team.name,
    role: team.role,
    machine: null,
  }));
  const canAdd = entitlement.plan === "pro" && rows.length < config.cloudMaxPerAccount;
  const machineState = primary?.status === "ready" ? "ready" : primary?.status === "setting_up" ? "setting_up" : primary ? "stopped" : null;
  return {
    cloudContractVersion: 1,
    expiresAt: Number(session.expires_at),
    device: { id: session.device_id },
    account: { id: session.account_id, email: session.account_email },
    entitlement,
    ...(primary && machineState ? {
      cloud: {
        state: machineState,
        ...(primary.origin ? { origin: primary.origin } : {}),
        ...(machineState === "setting_up" ? { setup: { step: primary.setup_step || "reserving" } } : {}),
        ...(primary.disk_gb ? { disk: { gb: Number(primary.disk_gb), maxGb: Number(primary.max_disk_gb || config.cloudMaxDiskGb) } } : {}),
        ...(machineState === "ready" ? { power: { state: primary.power_state || "awake", since: Number(primary.updated_at), sleeps: false } } : {}),
      },
    } : {}),
    clouds,
    canAdd,
    ...(canAdd ? {} : { addBlocked: rows.length >= config.cloudMaxPerAccount ? "cap" : "signups_closed" }),
    teams,
    organizations: { planCloudId: null, canAdd: false, addBlocked: "off", count: 0, max: 0 },
    latestVersion: config.latestVersion,
  };
}

export function newEmailAttempt(config, { email, purpose, userCode = null, checkoutId = null, deviceName = null, platform = null, appVersion = null }) {
  const attempt = randomBytesB64u(32);
  const code = newEightDigit();
  return {
    attempt,
    code,
    attemptHash: sha256Hex(attempt),
    codeHash: hmacHex(config.relaySeed, "otp", email, purpose, code),
    email,
    purpose,
    userCode,
    checkoutId,
    deviceName,
    platform,
    appVersion,
    expiresAt: Date.now() + config.otpTtlSeconds * 1000,
  };
}

export function codeMatches(config, email, purpose, expected, provided) {
  return hmacHex(config.relaySeed, "otp", email, purpose, provided) === expected;
}

import {
  cleanEmail,
  cleanInstallationClientId,
  cleanVersion,
  isInstallationId,
  newInstallationCredential,
  newUuid,
  randomBytesB64u,
  sha256Hex,
  signRelayToken,
} from "./crypto.js";
import { controlSession, installationAuth, sendOtp, verifyOtp } from "./helpers.js";
import { HttpError, json } from "./http.js";

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

const CREDENTIAL_DAYS = 365;
const CONTROL_SESSION_DAYS = 30;
const RELAY_HOST = /^(?:relay[1-9][0-9]?|cloud)\.dexai\.vip$/;

export async function handleControl(ctx) {
  for (const entry of routes) {
    if (entry.method !== ctx.method) continue;
    const match = typeof entry.pattern === "string" ? (ctx.path === entry.pattern ? [] : null) : ctx.path.match(entry.pattern);
    if (!match) continue;
    await entry.handler(ctx, match);
    return true;
  }
  return false;
}

function installationShape(row) {
  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.name,
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.app_version ? { appVersion: row.app_version } : {}),
  };
}

function issueCredential(ctx, installationId) {
  const credential = newInstallationCredential();
  const expiresAt = Date.now() + CREDENTIAL_DAYS * 24 * 60 * 60 * 1000;
  ctx.store.insertInstallationCredential({
    id: randomBytesB64u(16),
    installationId,
    tokenHash: sha256Hex(credential),
    expiresAt,
  });
  return { credential, credentialExpiresAt: expiresAt };
}

route("GET", "/healthz", async (ctx) => {
  json(ctx.res, 200, { ok: true, service: "openmausbot-control-plane", ...ctx.store.counts() });
});

route("POST", "/api/auth/email-otp/send-verification-otp", async (ctx) => {
  if (ctx.body.type !== "sign-in") throw new HttpError(400, "invalid_request");
  const email = cleanEmail(ctx.body.email);
  if (!email) return json(ctx.res, 200, {});
  try {
    await sendOtp(ctx, { email, purpose: "control" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return json(ctx.res, 200, {});
    if (error instanceof HttpError && error.status === 429) throw error;
    ctx.log(`control sign-in email failed: ${error?.code ?? error?.message ?? "unknown"}`);
  }
  json(ctx.res, 200, {});
});

route("POST", "/api/auth/sign-in/email-otp", async (ctx) => {
  const { account } = await verifyOtp(ctx, { email: ctx.body.email, code: ctx.body.otp, purpose: "control" });
  const token = `cps_${randomBytesB64u(32)}`;
  ctx.store.insertControlSession({
    id: randomBytesB64u(16),
    accountId: account.id,
    tokenHash: sha256Hex(token),
    expiresAt: Date.now() + CONTROL_SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  json(ctx.res, 200, { user: { id: account.id, email: account.email } }, { "set-auth-token": token });
});

route("POST", "/api/auth/sign-out", async (ctx) => {
  const session = controlSession(ctx);
  ctx.store.revokeControlSession(session.token_hash);
  json(ctx.res, 200, {});
});

route("GET", "/v1/me", async (ctx) => {
  const session = controlSession(ctx);
  json(ctx.res, 200, { user: { id: session.account_id, email: session.email } });
});

route("GET", "/v1/installations", async (ctx) => {
  const session = controlSession(ctx);
  json(ctx.res, 200, { installations: ctx.store.installationsFor(session.account_id).map(installationShape) });
});

/** The Cloud desktops this account owns, so a signed-in phone can open one without a desktop paired first. */
route("GET", "/v1/clouds", async (ctx) => {
  const session = controlSession(ctx);
  const clouds = ctx.store.cloudsFor(session.account_id)
    .filter((cloud) => cloud.status !== "ended" && cloud.role === "owner" && !cloud.team_id)
    .map((cloud) => ({
      id: cloud.id,
      name: cloud.name,
      status: cloud.status,
      origin: cloud.origin || (cloud.hostname ? `https://${cloud.hostname}` : null),
      ...(cloud.tier ? { tier: cloud.tier } : {}),
      ...(Number(cloud.last_seen_at) > 0 ? { lastSeenAt: Number(cloud.last_seen_at) } : {}),
    }));
  json(ctx.res, 200, { clouds });
});

route("POST", "/v1/installations", async (ctx) => {
  const session = controlSession(ctx);
  const clientInstanceId = cleanInstallationClientId(ctx.body.clientInstanceId);
  if (!clientInstanceId) throw new HttpError(400, "invalid_request");
  const name = typeof ctx.body.name === "string" && ctx.body.name.trim() && ctx.body.name.trim().length <= 100 ? ctx.body.name.trim() : "This computer";
  const platform = typeof ctx.body.platform === "string" ? ctx.body.platform.slice(0, 40) : null;
  const appVersion = cleanVersion(ctx.body.appVersion);
  const kind = ctx.body.kind === "server" ? "server" : ctx.body.kind === "phone" ? "phone" : "desktop";
  let installation = ctx.store.installationByClientInstance(session.account_id, clientInstanceId);
  if (installation) {
    ctx.store.revokeInstallationCredentials(installation.id);
  } else {
    installation = ctx.store.insertInstallation({
      id: newUuid(),
      accountId: session.account_id,
      clientInstanceId,
      name,
      platform,
      appVersion,
      kind,
    });
  }
  const credential = issueCredential(ctx, installation.id);
  json(ctx.res, 201, { installation: installationShape(installation), ...credential });
});

route("GET", "/v1/installations/self", async (ctx) => {
  const credential = installationAuth(ctx);
  const installation = ctx.store.installation(credential.installation_id);
  if (!installation) throw new HttpError(401, "invalid_token");
  json(ctx.res, 200, {
    installation: installationShape(installation),
    credentialExpiresAt: Number(credential.expires_at),
  });
});

route("POST", /^\/v1\/installations\/[0-9a-f-]{36}\/credentials\/rotate$/, async (ctx) => {
  const session = controlSession(ctx);
  const id = ctx.path.split("/")[3];
  if (!isInstallationId(id)) throw new HttpError(400, "invalid_request");
  const installation = ctx.store.installation(id);
  if (!installation || installation.account_id !== session.account_id) throw new HttpError(404, "not_found");
  ctx.store.revokeInstallationCredentials(id);
  const credential = issueCredential(ctx, id);
  json(ctx.res, 200, { installation: installationShape(installation), ...credential });
});

route("DELETE", /^\/v1\/installations\/[0-9a-f-]{36}$/, async (ctx) => {
  const session = controlSession(ctx);
  const id = ctx.path.split("/")[3];
  if (!isInstallationId(id)) throw new HttpError(400, "invalid_request");
  ctx.store.deleteInstallation(session.account_id, id);
  json(ctx.res, 200, {});
});

route("POST", "/v1/installations/self/endpoint", async (ctx) => {
  installationAuth(ctx);
  throw new HttpError(409, "relay_capable", { tunnel: "retired" });
});

route("GET", "/v1/installations/self/endpoint", async (ctx) => {
  installationAuth(ctx);
  json(ctx.res, 200, { endpoint: null });
});

route("DELETE", "/v1/installations/self/endpoint", async (ctx) => {
  installationAuth(ctx);
  json(ctx.res, 200, {});
});

route("POST", "/v1/installations/self/relay-token", async (ctx) => {
  const credential = installationAuth(ctx);
  const appVersion = cleanVersion(ctx.body.appVersion);
  if (!ctx.config.relaySeed) throw new HttpError(503, "relay_unavailable");
  if (!ctx.config.relayNodes.length || !ctx.config.relayNodes.every((node) => RELAY_HOST.test(node))) {
    throw new HttpError(503, "relay_unavailable");
  }
  const hostId = randomBytesB64u(16);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = signRelayToken({
    privateKey: ctx.relayKey.privateKey,
    kid: ctx.config.relayKid,
    hostId,
    installationId: credential.installation_id,
    nowSeconds,
  });
  ctx.log(`relay token issued for installation ${credential.installation_id.slice(0, 8)} (${appVersion})`);
  json(ctx.res, 200, {
    token: signed.token,
    hostId,
    nodes: [...ctx.config.relayNodes],
    expiresAt: signed.expiresAt,
    refreshAfter: signed.refreshAfter,
  });
});

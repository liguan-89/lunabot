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
// The relay nodes a computer may be sent to. A grant naming a host the app cannot parse is refused by the app, so
// this list and companion/src/e2e/descriptor.ts hold the same names. No `openmausbot.com`: that domain is not ours.
const RELAY_HOST = /^(?:relay[1-9][0-9]?\.openmausbot\.com|(?:relay[1-9][0-9]?|cloud)\.dexai\.vip)$/;

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

/** A computer counts as online when it has talked to the plane in the last five minutes. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function installationShape(row) {
  const lastSeenAt = Number(row.last_seen_at) || 0;
  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.name,
    // A phone needs this to tell a computer it can ask from one it cannot:
    // the account lists every installation, its own phones included.
    kind: row.kind ?? "desktop",
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.app_version ? { appVersion: row.app_version } : {}),
    ...(lastSeenAt > 0 ? { lastSeenAt, online: Date.now() - lastSeenAt < ONLINE_WINDOW_MS } : {}),
  };
}

const PAIR_REQUEST_TTL_MS = 5 * 60 * 1000;
const PAIR_REQUEST_HOURLY_CAP = 20;
const PAIR_LINK_MAX = 4096;

/** One request per installation owned by the account, so a leaked account is throttled and scoped. */
function ownedInstallation(ctx, accountId) {
  const id = ctx.path.split("/")[3];
  if (!isInstallationId(id)) throw new HttpError(400, "invalid_request");
  const installation = ctx.store.installation(id);
  if (!installation || installation.account_id !== accountId) throw new HttpError(404, "not_found");
  return installation;
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
  json(ctx.res, 200, { ok: true, service: "lunabot-control-plane", ...ctx.store.counts() });
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
/** A signed-in phone asks the computer to connect. The computer answers with the same link a QR carries. */
route("POST", /^\/v1\/installations\/[0-9a-f-]{36}\/pair-requests$/, async (ctx) => {
  const session = controlSession(ctx);
  const installation = ownedInstallation(ctx, session.account_id);
  ctx.store.expirePairRequests();
  if (ctx.store.pairRequestCount(installation.id, Date.now() - 60 * 60 * 1000) >= PAIR_REQUEST_HOURLY_CAP) {
    throw new HttpError(429, "too_many_requests");
  }
  const deviceName = String(ctx.body.deviceName ?? "").trim().slice(0, 64) || "A phone";
  const request = {
    id: newUuid(),
    installationId: installation.id,
    accountId: session.account_id,
    deviceName,
    expiresAt: Date.now() + PAIR_REQUEST_TTL_MS,
  };
  ctx.store.insertPairRequest(request);
  json(ctx.res, 201, { requestId: request.id, expiresAt: request.expiresAt });
});

/** The phone watches its own request; the link appears only after the computer approved it. */
route("GET", /^\/v1\/installations\/[0-9a-f-]{36}\/pair-requests\/[0-9a-f-]{36}$/, async (ctx) => {
  const session = controlSession(ctx);
  const installation = ownedInstallation(ctx, session.account_id);
  ctx.store.expirePairRequests();
  const request = ctx.store.pairRequest(ctx.path.split("/")[5]);
  if (!request || request.installation_id !== installation.id || request.account_id !== session.account_id) {
    throw new HttpError(404, "not_found");
  }
  json(ctx.res, 200, {
    status: request.status,
    ...(request.status === "allowed" && request.link ? { link: request.link } : {}),
    ...(request.status === "denied" ? { reason: "declined" } : {}),
    expiresAt: Number(request.expires_at),
  });
});

/** The desktop asks what is waiting for it. */
route("GET", "/v1/installations/self/pair-requests", async (ctx) => {
  const credential = installationAuth(ctx);
  ctx.store.touchInstallation(credential.installation_id);
  ctx.store.expirePairRequests();
  const pending = ctx.store.pendingPairRequests(credential.installation_id).map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  }));
  json(ctx.res, 200, { requests: pending });
});

/** The desktop approves (with the link it minted) or declines. Only an allow carries the link. */
route("POST", /^\/v1\/installations\/self\/pair-requests\/[0-9a-f-]{36}$/, async (ctx) => {
  const credential = installationAuth(ctx);
  ctx.store.expirePairRequests();
  const id = ctx.path.split("/")[5];
  const request = ctx.store.pairRequest(id);
  if (!request || request.installation_id !== credential.installation_id) throw new HttpError(404, "not_found");
  const decision = ctx.body.decision === "allow" ? "allow" : ctx.body.decision === "deny" ? "deny" : null;
  if (!decision) throw new HttpError(400, "invalid_request");
  if (request.status !== "pending") throw new HttpError(409, "not_pending");
  if (decision === "allow") {
    const link = typeof ctx.body.link === "string" ? ctx.body.link.trim() : "";
    if (!link.startsWith("lunabot://pair") || link.length > PAIR_LINK_MAX) throw new HttpError(400, "invalid_request");
    ctx.store.answerPairRequest(id, { status: "allowed", link });
  } else {
    ctx.store.answerPairRequest(id, { status: "denied" });
  }
  json(ctx.res, 200, { status: decision === "allow" ? "allowed" : "denied" });
});

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

/** A one-time pairing code for this account's own Cloud, so a signed-in phone
 * can pair to it directly instead of opening it in a browser. */
route("POST", /^\/v1\/clouds\/[A-Za-z0-9_-]{1,64}\/pairing$/, async (ctx) => {
  const session = controlSession(ctx);
  const id = ctx.path.split("/")[3];
  const cloud = ctx.store.cloud(id);
  if (!cloud || cloud.account_id !== session.account_id || cloud.status === "ended") throw new HttpError(404, "not_found");
  try {
    const grant = await ctx.provisioner.pairing(cloud);
    json(ctx.res, 200, grant);
  } catch (error) {
    if (error?.code === "not_running") throw new HttpError(409, "not_running");
    ctx.log(`control pairing ${cloud.id} failed: ${error?.message ?? error}`);
    throw new HttpError(502, "pairing_failed");
  }
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
    // Signing in again is also the newest thing the plane knows about this
    // device: refresh the row so a rename or an upgrade lands without a
    // second round trip.
    ctx.store.updateInstallationProfile(installation.id, { name, platform, appVersion });
    installation = ctx.store.installation(installation.id);
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

/**
 * A signed-in device says it is still here.
 *
 * Phones authenticate with the account session, never with an installation
 * credential, so they have no request of their own that would touch their row:
 * without this, their `last_seen_at` stays at the moment they signed in, and
 * the sweeper cannot tell a daily phone from a forgotten one.
 *
 * It deliberately does not mint a credential. `POST /v1/installations` does,
 * and a phone calling that on every settings screen would revoke the
 * credential its own desktop is polling with.
 */
route("POST", "/v1/installations/self/presence", async (ctx) => {
  const session = controlSession(ctx);
  const clientInstanceId = cleanInstallationClientId(ctx.body.clientInstanceId);
  if (!clientInstanceId) throw new HttpError(400, "invalid_request");
  const reported = typeof ctx.body.name === "string" ? ctx.body.name.trim().slice(0, 100) : "";
  const platform = typeof ctx.body.platform === "string" ? ctx.body.platform.slice(0, 40) : null;
  const appVersion = cleanVersion(ctx.body.appVersion);
  let installation = ctx.store.installationByClientInstance(session.account_id, clientInstanceId);
  if (installation) {
    ctx.store.updateInstallationProfile(installation.id, {
      name: reported || installation.name,
      platform,
      appVersion,
    });
  } else {
    // The row was swept while the phone stayed signed in, or this is the first
    // report after the app updated. Rebuilding it keeps the device list honest.
    installation = ctx.store.insertInstallation({
      id: newUuid(),
      accountId: session.account_id,
      clientInstanceId,
      name: reported || "This phone",
      platform: platform ?? "android",
      appVersion,
      kind: "phone",
    });
  }
  json(ctx.res, 200, { installation: installationShape(ctx.store.installation(installation.id)) });
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
  // Stable per installation: a paired phone pins the descriptor's `h` and keeps
  // dialling it, so a fresh identity per token would leave it knocking on a
  // hostId the relay no longer has (4404) while both ends are online.
  const hostId = ctx.store.relayHostId(credential.installation_id, () => randomBytesB64u(16));
  if (!hostId) throw new HttpError(500, "relay_unavailable");
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

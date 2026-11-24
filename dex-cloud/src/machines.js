import { createHash, createHmac } from "node:crypto";

import { isVersion, sameSecret } from "./crypto.js";
import { HttpError, json } from "./http.js";

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

export async function handleMachines(ctx) {
  for (const entry of routes) {
    if (entry.method !== ctx.method) continue;
    const match = typeof entry.pattern === "string" ? (ctx.path === entry.pattern ? [] : null) : ctx.path.match(entry.pattern);
    if (!match) continue;
    await entry.handler(ctx, match);
    return true;
  }
  return false;
}

const SKEW_MS = 5 * 60 * 1000;
const NONCE = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * A Cloud home signs each call to the plane over the exact request bytes with the bootstrap secret the provisioner
 * injected (`omb-<purpose>-v1\n<machine>\n<timestamp>\n<nonce>\n<body hash>`), and the plane answers 401 rather than
 * guess which part was tampered with. `hash` follows the caller: the wake notice hashes its body as hex, the pages
 * token route as base64url — both fixed in `server/cloud-woke.ts` and `server/pages/access.ts`.
 */
export function verifyHomeCall(ctx, prefix, { hash = "base64url" } = {}) {
  const machineId = String(ctx.req.headers["x-lunabot-cloud-machine"] ?? "");
  const timestamp = String(ctx.req.headers["x-lunabot-cloud-timestamp"] ?? "");
  const nonce = String(ctx.req.headers["x-lunabot-cloud-nonce"] ?? "");
  const signature = String(ctx.req.headers["x-lunabot-cloud-signature"] ?? "");
  const sent = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(sent) || Math.abs(Date.now() - sent) > SKEW_MS || !NONCE.test(nonce)) {
    throw new HttpError(401, "invalid_signature");
  }
  const cloud = ctx.store.cloudByMachineId(machineId);
  if (!cloud?.bootstrap_secret) throw new HttpError(401, "invalid_signature");
  const bodyHash = createHash("sha256").update(ctx.rawBody).digest(hash);
  const message = `${prefix}\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const expected = `v1=${createHmac("sha256", cloud.bootstrap_secret).update(message).digest("base64url")}`;
  if (!sameSecret(signature, expected)) throw new HttpError(401, "invalid_signature");
  return cloud;
}

/**
 * The home reports each wake (a resume, or a boot from a sleep it was stopped for), so `cloud.power` moves on at the
 * desktops' next session read instead of at the plane's next power probe. `docs/cloud-pro.md`, "Sleeping homes".
 * It also carries the running build: `clouds.version` is otherwise never written, and the session payload reads it.
 */
route("POST", "/api/cloud/machines/woke", async (ctx) => {
  const cloud = verifyHomeCall(ctx, "omb-power-woke-v1", { hash: "hex" });
  const version = isVersion(ctx.body.version) ? ctx.body.version : null;
  ctx.store.updateCloud(cloud.id, {
    power_state: "awake",
    last_seen_at: Date.now(),
    ...(version ? { version } : {}),
  });
  json(ctx.res, 200, { ok: true });
});

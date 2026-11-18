import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

export function fromB64u(text, expectedLength) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bytes = Buffer.from(text, "base64url");
    if (expectedLength !== undefined && bytes.length !== expectedLength) return null;
    if (bytes.toString("base64url") !== text) return null;
    return bytes;
  } catch {
    return null;
  }
}

export const randomBytesB64u = (length = 32) => b64u(randomBytes(length));

export const randomToken = (prefix, bytes = 32) => `${prefix}${randomBytesB64u(bytes)}`;

export const sha256Hex = (text) => createHash("sha256").update(String(text)).digest("hex");

export function hmacHex(secret, ...parts) {
  const hmac = createHmac("sha256", secret);
  for (const part of parts) hmac.update(String(part));
  return hmac.digest("hex");
}

export function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAN_TIER = /^[a-z][a-z0-9-]{0,23}$/;

function pick(alphabet, length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

export const newUserCode = () => `${pick(USER_CODE_ALPHABET, 5)}-${pick(USER_CODE_ALPHABET, 5)}`;
export const newEightDigit = () => String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, "0");
export const newUuid = () => cryptoRandomUuid();

function cryptoRandomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isVersion = (value) => typeof value === "string" && VERSION.test(value);
export const isCloudId = (value) => typeof value === "string" && CLOUD_ID.test(value);
export const isInstallationId = (value) => typeof value === "string" && INSTALLATION_ID.test(value);
export const isPlanTier = (value) => typeof value === "string" && PLAN_TIER.test(value);

export function cleanEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

const hasControlCharacter = (text) =>
  [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

export function cleanDeviceName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 100 || hasControlCharacter(name)) return null;
  return name;
}

export const cleanPlatform = (value) =>
  value === "darwin" || value === "win32" || value === "linux" ? value : null;

export const cleanVersion = (value) => (isVersion(value) ? value : "0.0.0");

export function cleanInstallationClientId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : null;
}

export function newInstallationCredential() {
  return `omb_install_${randomBytesB64u(16)}.${randomBytesB64u(32)}`;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function relaySigningKey(seedText) {
  const seed = fromB64u(seedText, 32);
  if (!seed) throw new Error("relay seed must be a base64url 32-byte value");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, publicKey: publicJwk.x };
}

export function signRelayToken({ privateKey, kid, hostId, installationId, nowSeconds, lifetimeSeconds = 12 * 3600 }) {
  const payload = {
    v: 1,
    kid,
    hid: hostId,
    iid: installationId,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
  };
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(null, Buffer.from(body, "ascii"), privateKey);
  return { token: `${body}.${b64u(signature)}`, hostId, expiresAt: payload.exp * 1000, refreshAfter: (nowSeconds + 3600) * 1000 };
}

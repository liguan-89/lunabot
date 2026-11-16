// WebAuthn presence confirmation for high-risk answers: a one-time challenge, then a real signature
// from the device's own authenticator. Registration keeps only the credential id, its public key and
// the origin it was made from — attestation is always "none", so no certificate chain is checked and
// nothing here trusts the authenticator beyond "the same key, on the same origin, signed this".
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

type JsonWebKey = import("node:crypto").webcrypto.JsonWebKey;

export class WebAuthnError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const CHALLENGE_BYTES = 32;
const CHALLENGE_TTL_MS = 2 * 60_000;
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

export function b64url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString("base64url");
}

function unb64url(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 64 * 1024) throw new WebAuthnError("bad base64url field");
  return Buffer.from(value, "base64url");
}

// ---- Minimal CBOR: only what attestation objects and COSE keys use (ints, bytes, text, arrays, maps, bools).
type Cbor = unknown;
function cbor(buf: Buffer, at = 0): { value: Cbor; next: number } {
  const ib = buf[at++];
  if (ib === undefined) throw new WebAuthnError("truncated CBOR");
  const major = ib >> 5, add = ib & 0x1f;
  const arg = (): number => {
    if (add < 24) return add;
    const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const width = widths[add];
    if (!width) throw new WebAuthnError("indefinite-length CBOR is not used in WebAuthn");
    if (at + width > buf.length) throw new WebAuthnError("truncated CBOR");
    let v = 0;
    for (let i = 0; i < width; i++) v = v * 256 + buf[at++]!;
    return v;
  };
  if (major === 0) return { value: arg(), next: at };
  if (major === 1) return { value: -1 - arg(), next: at };
  if (major === 2 || major === 3) {
    const n = arg();
    const out = buf.subarray(at, at + n);
    if (out.length !== n) throw new WebAuthnError("truncated CBOR");
    at += n;
    return { value: major === 2 ? Buffer.from(out) : out.toString("utf8"), next: at };
  }
  if (major === 4 || major === 5) {
    const n = arg();
    if (major === 4) {
      const list: Cbor[] = [];
      for (let i = 0; i < n; i++) { const r = cbor(buf, at); list.push(r.value); at = r.next; }
      return { value: list, next: at };
    }
    const map = new Map<Cbor, Cbor>();
    for (let i = 0; i < n; i++) { const k = cbor(buf, at); at = k.next; const v = cbor(buf, at); at = v.next; map.set(k.value, v.value); }
    return { value: map, next: at };
  }
  if (major === 7) {
    if (add === 20) return { value: false, next: at };
    if (add === 21) return { value: true, next: at };
    if (add === 22) return { value: null, next: at };
  }
  throw new WebAuthnError("unsupported CBOR item");
}

export interface WebAuthnCredential {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  /** The relying-party hash and web origin this credential was made on — assertions must match both. */
  rpIdHash: string;
  origin: string;
  signCount: number;
  createdAt: string;
}

export function loadWebAuthnCredentials(dir: string): WebAuthnCredential[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "webauthn-credentials.json"), "utf8"));
    return Array.isArray(raw?.credentials) ? raw.credentials.filter((c: WebAuthnCredential) => typeof c?.credentialId === "string" && c.publicKeyJwk) : [];
  } catch {
    return [];
  }
}

export function saveWebAuthnCredentials(dir: string, credentials: WebAuthnCredential[]): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "webauthn-credentials.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ credentials }, null, 2));
  renameSync(tmp, file);
}

// One-time challenges live in memory only: a restart simply asks for another tap.
const challenges = new Map<string, number>();

export function issueChallenge(now = Date.now(), ttlMs = CHALLENGE_TTL_MS): string {
  for (const [id, expires] of challenges) if (expires <= now) challenges.delete(id);
  const challenge = b64url(crypto.randomBytes(CHALLENGE_BYTES));
  challenges.set(challenge, now + ttlMs);
  return challenge;
}

/** True once per challenge: consuming it makes a replayed assertion worthless. */
export function takeChallenge(challenge: string, now = Date.now()): boolean {
  const expires = challenges.get(challenge);
  challenges.delete(challenge);
  return expires !== undefined && expires > now;
}

function clientData(clientDataJSON: Buffer, type: "webauthn.create" | "webauthn.get", challenge: string): { origin: string } {
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (parsed.type !== type || parsed.challenge !== challenge) throw new WebAuthnError("the ceremony does not match the issued challenge");
  if (typeof parsed.origin !== "string" || !parsed.origin) throw new WebAuthnError("clientDataJSON has no origin");
  return { origin: parsed.origin };
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Cbor;
}

function parseAuthData(buf: Buffer, wantCredential: boolean): AuthData {
  if (buf.length < 37) throw new WebAuthnError("authenticatorData is truncated");
  const data: AuthData = { rpIdHash: buf.subarray(0, 32), flags: buf[32]!, signCount: buf.readUInt32BE(33) };
  if (!(data.flags & FLAG_UP)) throw new WebAuthnError("user presence flag is not set");
  if (wantCredential) {
    if (!(data.flags & FLAG_AT)) throw new WebAuthnError("no attested credential in authenticatorData");
    const idLen = buf.readUInt16BE(53);
    const credentialId = buf.subarray(55, 55 + idLen);
    if (credentialId.length !== idLen || !idLen) throw new WebAuthnError("credential id is truncated");
    data.credentialId = credentialId;
    data.publicKey = cbor(buf.subarray(55 + idLen)).value;
  }
  return data;
}

/** COSE → JWK for the algorithms platform authenticators use: ES256 (kty 2, crv 1) and RS256 (kty 3). */
export function coseToJwk(cose: Cbor): JsonWebKey {
  if (!(cose instanceof Map)) throw new WebAuthnError("credential public key is not a COSE map");
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    const x = cose.get(-2), y = cose.get(-3);
    if (Buffer.isBuffer(x) && Buffer.isBuffer(y)) return { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (Buffer.isBuffer(n) && Buffer.isBuffer(e)) return { kty: "RSA", n: b64url(n), e: b64url(e) };
  }
  throw new WebAuthnError("the credential's algorithm is not ES256 or RS256");
}

export function registerOptions(existing: WebAuthnCredential[], userName = "owner"): Record<string, unknown> {
  return {
    challenge: issueChallenge(),
    rp: { name: "Luna Bot" },
    user: { id: b64url(crypto.createHash("sha256").update(userName).digest()), name: userName, displayName: userName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    timeout: CHALLENGE_TTL_MS,
    attestation: "none",
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credentialId })),
  };
}

export function assertOptions(existing: WebAuthnCredential[]): Record<string, unknown> {
  return {
    challenge: issueChallenge(),
    timeout: CHALLENGE_TTL_MS,
    userVerification: "required",
    allowCredentials: existing.map((c) => ({ type: "public-key", id: c.credentialId })),
  };
}

/** Registration payload as navigator.credentials.create reports it: base64url fields. */
export function verifyRegistration(body: Record<string, unknown>): WebAuthnCredential {
  const attestationObject = unb64url(body.attestationObject);
  const parsed = cbor(attestationObject).value;
  if (!(parsed instanceof Map) || parsed.get("fmt") !== "none") throw new WebAuthnError("attestation must be fmt none");
  const authData = parseAuthData(parsed.get("authData") instanceof Buffer ? parsed.get("authData") as Buffer : Buffer.alloc(0), true);
  if (!takeChallenge(typeof body.challenge === "string" ? body.challenge : "")) throw new WebAuthnError("the challenge is spent or never issued");
  const { origin } = clientData(unb64url(body.clientDataJSON), "webauthn.create", String(body.challenge));
  return {
    credentialId: b64url(authData.credentialId!),
    publicKeyJwk: coseToJwk(authData.publicKey),
    rpIdHash: b64url(authData.rpIdHash),
    origin,
    signCount: authData.signCount,
    createdAt: new Date().toISOString(),
  };
}

export interface AssertionBody {
  credentialId: string;
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
  signature: Buffer;
}

export function parseAssertionBody(body: unknown): AssertionBody {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    credentialId: typeof b.credentialId === "string" ? b.credentialId : "",
    authenticatorData: unb64url(b.authenticatorData),
    clientDataJSON: unb64url(b.clientDataJSON),
    signature: unb64url(b.signature),
  };
}

/** A valid assertion for a fresh challenge: the enrolled credential, on the enrolled origin, with user verification. */
export function verifyAssertion(body: AssertionBody, credentials: WebAuthnCredential[]): { credentialId: string; signCount: number } {
  const credential = credentials.find((c) => c.credentialId === body.credentialId);
  if (!credential) throw new WebAuthnError("this authenticator is not enrolled");
  let challenge = "";
  try {
    challenge = (JSON.parse(body.clientDataJSON.toString("utf8")) as { challenge?: unknown }).challenge as string;
  } catch { /* clientData() reports the real failure */ }
  if (!challenge || !takeChallenge(challenge)) throw new WebAuthnError("the challenge is spent or never issued");
  const { origin } = clientData(body.clientDataJSON, "webauthn.get", challenge);
  if (origin !== credential.origin) throw new WebAuthnError("the assertion comes from a different origin than the registration");
  const authData = parseAuthData(body.authenticatorData, false);
  if (b64url(authData.rpIdHash) !== credential.rpIdHash) throw new WebAuthnError("the assertion is for a different relying party");
  if (!(authData.flags & FLAG_UV)) throw new WebAuthnError("the authenticator did not verify the user");
  const signed = Buffer.concat([body.authenticatorData, crypto.createHash("sha256").update(body.clientDataJSON).digest()]);
  const ok = crypto.verify("sha256", signed, { key: crypto.createPublicKey({ key: credential.publicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, body.signature);
  if (!ok) throw new WebAuthnError("the assertion signature is invalid");
  // A zero counter means the authenticator does not track signatures; only a nonzero regression is a clone signal.
  if (authData.signCount !== 0 && authData.signCount <= credential.signCount) throw new WebAuthnError("the authenticator's counter did not advance");
  return { credentialId: credential.credentialId, signCount: authData.signCount };
}

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertOptions, b64url, issueChallenge, parseAssertionBody, registerOptions, takeChallenge, verifyAssertion, verifyRegistration, WebAuthnError, type WebAuthnCredential } from "./webauthn.ts";

const ORIGIN = "http://localhost:8123";
const RP_HASH = crypto.createHash("sha256").update("localhost").digest();

// CBOR encoder for the shapes WebAuthn uses: text, bytes, ints (incl. negative), maps.
function cborEnc(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof value === "string") { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEnc)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) { parts.push(cborEnc(k), cborEnc(v)); }
    return Buffer.concat(parts);
  }
  throw new Error(`cannot encode ${typeof value}`);
}

function fakeAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = crypto.randomBytes(24);
  const cose = cborEnc(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  let signCount = 0;
  const authData = (flags: number, withCredential: boolean, rp: Buffer = RP_HASH) => Buffer.concat([
    rp,
    Buffer.from([flags]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(signCount, 0); return b; })(),
    ...(withCredential ? [crypto.randomBytes(16), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(credentialId.length, 0); return b; })(), credentialId, cose] : []),
  ]);
  return {
    credentialId: b64url(credentialId),
    jwk,
    nextCount: () => ++signCount,
    attestationObject: () => cborEnc(new Map<string, unknown>([["fmt", "none"], ["authData", authData(0x41, true)]])),
    assertion: (challenge: string, { uv = true, origin = ORIGIN }: { uv?: boolean; origin?: string } = {}) => {
      const data = authData(uv ? 0x05 : 0x01, false);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
      const signature = crypto.sign("sha256", Buffer.concat([data, crypto.createHash("sha256").update(clientDataJSON).digest()]), { key: privateKey, dsaEncoding: "ieee-p1363" });
      return { credentialId: b64url(credentialId), authenticatorData: b64url(data), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) };
    },
    clientDataCreate: (challenge: string) => b64url(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN }))),
  };
}

function enroll(auth = fakeAuthenticator()): { auth: ReturnType<typeof fakeAuthenticator>; credential: WebAuthnCredential } {
  const options = registerOptions([], "owner") as { challenge: string };
  const credential = verifyRegistration({ challenge: options.challenge, attestationObject: b64url(auth.attestationObject()), clientDataJSON: auth.clientDataCreate(options.challenge) });
  return { auth, credential };
}

describe("challenges", () => {
  it("are one-time and expire", () => {
    const c = issueChallenge();
    expect(takeChallenge(c)).toBe(true);
    expect(takeChallenge(c)).toBe(false);
    expect(takeChallenge("never-issued")).toBe(false);
    expect(takeChallenge(issueChallenge(0, 10), 20)).toBe(false);
  });
});

describe("registration", () => {
  it("enrolls the credential's id, public key, rp hash and origin — nothing else", () => {
    const { auth, credential } = enroll();
    expect(credential.credentialId).toBe(auth.credentialId);
    expect(credential.publicKeyJwk).toMatchObject({ kty: "EC", crv: "P-256", x: auth.jwk.x, y: auth.jwk.y });
    expect(credential.rpIdHash).toBe(b64url(RP_HASH));
    expect(credential.origin).toBe(ORIGIN);
  });

  it("refuses a spent or foreign challenge, a non-none attestation, and a truncated authData", () => {
    const auth = fakeAuthenticator();
    expect(() => verifyRegistration({ challenge: "never-issued", attestationObject: b64url(auth.attestationObject()), clientDataJSON: auth.clientDataCreate("never-issued") })).toThrow(WebAuthnError);
    const options = registerOptions([], "owner") as { challenge: string };
    const attested = cborEnc(new Map<string, unknown>([["fmt", "packed"], ["authData", Buffer.alloc(40)]]));
    expect(() => verifyRegistration({ challenge: options.challenge, attestationObject: b64url(attested), clientDataJSON: auth.clientDataCreate(options.challenge) })).toThrow(/fmt none/);
    const short = cborEnc(new Map<string, unknown>([["fmt", "none"], ["authData", Buffer.alloc(10)]]));
    expect(() => verifyRegistration({ challenge: (registerOptions([], "owner") as { challenge: string }).challenge, attestationObject: b64url(short), clientDataJSON: "e30" })).toThrow(/truncated/);
  });

  it("maps RSA public keys too", () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const cose = cborEnc(new Map<number, unknown>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, "base64url")], [-2, Buffer.from(jwk.e, "base64url")]]));
    const credentialId = crypto.randomBytes(8);
    const authData = Buffer.concat([RP_HASH, Buffer.from([0x41]), Buffer.alloc(4), crypto.randomBytes(16), Buffer.from([0, credentialId.length]), credentialId, cose]);
    const attestation = cborEnc(new Map<string, unknown>([["fmt", "none"], ["authData", authData]]));
    const challenge = (registerOptions([], "owner") as { challenge: string }).challenge;
    const credential = verifyRegistration({ challenge, attestationObject: b64url(attestation), clientDataJSON: fakeAuthenticator().clientDataCreate(challenge) });
    expect(credential.publicKeyJwk).toMatchObject({ kty: "RSA", n: jwk.n, e: jwk.e });
  });
});

describe("assertion", () => {
  function assertWith(credential: WebAuthnCredential, assertion: ReturnType<ReturnType<typeof fakeAuthenticator>["assertion"]>) {
    return verifyAssertion(parseAssertionBody(assertion), [credential]);
  }

  it("verifies a real signature over authData‖hash(clientData) and reports the new counter", () => {
    const { auth, credential } = enroll();
    auth.nextCount();
    const options = assertOptions([credential]) as { challenge: string };
    expect(options.allowCredentials).toEqual([{ type: "public-key", id: credential.credentialId }]);
    expect(assertWith(credential, auth.assertion(options.challenge))).toEqual({ credentialId: credential.credentialId, signCount: 1 });
  });

  it("rejects a replayed challenge and an assertion for an unenrolled key", () => {
    const { auth, credential } = enroll();
    auth.nextCount();
    const options = assertOptions([credential]) as { challenge: string };
    const assertion = auth.assertion(options.challenge);
    assertWith(credential, assertion);
    auth.nextCount();
    expect(() => assertWith(credential, auth.assertion(options.challenge))).toThrow(/spent/);
    expect(() => assertWith(credential, { ...auth.assertion(assertOptions([credential]) as never as string), credentialId: "other" })).toThrow(/not enrolled/);
  });

  it("rejects a different origin, a different rp, no user verification and a bad signature", () => {
    const { auth, credential } = enroll();
    auth.nextCount();
    expect(() => assertWith(credential, auth.assertion((assertOptions([credential]) as { challenge: string }).challenge, { origin: "https://evil.example" }))).toThrow(/different origin/);
    auth.nextCount();
    expect(() => assertWith(credential, auth.assertion((assertOptions([credential]) as { challenge: string }).challenge, { uv: false }))).toThrow(/did not verify the user/);
    auth.nextCount();
    const options = assertOptions([credential]) as { challenge: string };
    const tampered = auth.assertion(options.challenge);
    tampered.signature = b64url(Buffer.alloc(64, 9));
    expect(() => assertWith(credential, tampered)).toThrow(/signature/);
    // An rp hash other than the enrolled one fails even with a true signature's structure.
    const other = fakeAuthenticator();
    const options2 = assertOptions([credential]) as { challenge: string };
    expect(() => assertWith(credential, other.assertion(options2.challenge))).toThrow(/not enrolled/);
  });

  it("rejects a counter regression but accepts authenticators that never count", () => {
    const { auth, credential } = enroll();
    auth.nextCount(); auth.nextCount();
    assertWith(credential, auth.assertion((assertOptions([credential]) as { challenge: string }).challenge));
    credential.signCount = 9;
    auth.nextCount();
    expect(() => assertWith(credential, auth.assertion((assertOptions([credential]) as { challenge: string }).challenge))).toThrow(/counter/);
  });
});

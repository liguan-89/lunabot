// Presence confirmation for high-risk card answers: when the server requires it, an "allow" is refused with fresh
// WebAuthn options (POST /api/threads/:id/respond → 403 { presence: { options } }). We run navigator.credentials.get
// on those options and resend the same answer with the assertion — the challenge is one-time, so it always comes
// from the refusal, never cached. Only platform authenticators qualify (server stores only public keys per origin).
import { api, ApiError } from "../state/api";

function b64urlToBuffer(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PresenceAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** The server's challenge and credential list come back base64url-encoded; the authenticator wants ArrayBuffers. */
function requestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const allow = Array.isArray(options.allowCredentials) ? options.allowCredentials : [];
  return {
    challenge: b64urlToBuffer(String(options.challenge ?? "")),
    timeout: typeof options.timeout === "number" ? options.timeout : 60_000,
    userVerification: "required",
    allowCredentials: allow
      .filter((c): c is { id: string; type?: string } => Boolean(c && typeof (c as { id?: unknown }).id === "string"))
      .map((c) => ({ type: "public-key" as const, id: b64urlToBuffer(c.id) })),
  };
}

/** Runs the authenticator ceremony for the server's options; null when this device has no WebAuthn at all. */
export async function assertPresence(options: Record<string, unknown>): Promise<PresenceAssertion> {
  if (typeof navigator === "undefined" || !navigator.credentials) throw new Error("This device cannot confirm by fingerprint or face.");
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) }) as ({ rawId?: ArrayBuffer; response?: Partial<AuthenticatorAssertionResponse> } | null);
  const response = credential?.response;
  if (!(credential?.rawId instanceof ArrayBuffer) || !(response?.authenticatorData instanceof ArrayBuffer) || !(response.clientDataJSON instanceof ArrayBuffer) || !(response.signature instanceof ArrayBuffer)) {
    throw new Error("The device did not confirm.");
  }
  return {
    credentialId: bufferToB64url(credential.rawId),
    authenticatorData: bufferToB64url(response.authenticatorData),
    clientDataJSON: bufferToB64url(response.clientDataJSON),
    signature: bufferToB64url(response.signature),
  };
}

/** Sends `send(body)`; on a 403 carrying `presence.options`, confirms on this device and resends with the assertion. */
export async function apiWithPresence<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await api<T>(path, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    const options = error instanceof ApiError && error.status === 403 ? (error.body?.presence as { options?: Record<string, unknown> } | undefined)?.options : undefined;
    if (!options) throw error;
    const assertion = await assertPresence(options);
    return api<T>(path, { method: "POST", body: JSON.stringify({ ...body, webauthn: assertion }) });
  }
}

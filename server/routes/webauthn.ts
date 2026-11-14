// Enrolling a platform authenticator and proving the saved key still answers. The credential itself
// is the only thing stored; every challenge is one-time and lives only in the process.
import { z } from "zod";
import { assertOptions, parseAssertionBody, registerOptions, verifyAssertion, verifyRegistration, WebAuthnError, type WebAuthnCredential } from "../webauthn.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WebAuthnRouteDeps {
  credentials(): WebAuthnCredential[];
  saveCredentials(credentials: WebAuthnCredential[]): void;
  /** The owner's sign-in name, for the credential's user record. */
  ownerName(): string;
}

const registrationBody = z.object({
  challenge: z.string().min(1),
  attestationObject: z.string().min(1),
  clientDataJSON: z.string().min(1),
}).strict();

export function createWebAuthnRoutes(deps: WebAuthnRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/webauthn/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only an admin manages presence confirmation." });

    if (method === "GET" && path === "/api/webauthn/status") {
      return json(res, 200, { enrolled: deps.credentials().length });
    }

    if (method === "POST" && path === "/api/webauthn/register/options") {
      return json(res, 200, { options: registerOptions(deps.credentials(), deps.ownerName()) });
    }

    if (method === "POST" && path === "/api/webauthn/register") {
      let body: z.infer<typeof registrationBody>;
      try {
        body = registrationBody.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "The registration payload was not valid." });
      }
      try {
        const credential = verifyRegistration(body);
        const credentials = [...deps.credentials().filter((c) => c.credentialId !== credential.credentialId), credential];
        deps.saveCredentials(credentials);
        return json(res, 200, { enrolled: credentials.length });
      } catch (error) {
        return json(res, 400, { error: `The authenticator's answer was not accepted: ${error instanceof WebAuthnError ? error.reason : "bad ceremony"}.` });
      }
    }

    if (method === "POST" && path === "/api/webauthn/assert/options") {
      const credentials = deps.credentials();
      if (!credentials.length) return json(res, 409, { error: "No authenticator is enrolled yet." });
      return json(res, 200, { options: assertOptions(credentials) });
    }

    // A dry-run assertion endpoint exists so the enrollment check can prove the key answers before it is required.
    if (method === "POST" && path === "/api/webauthn/assert") {
      try {
        verifyAssertion(parseAssertionBody(await readBody(req)), deps.credentials());
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 403, { error: error instanceof WebAuthnError ? error.reason : "the assertion was not accepted" });
      }
    }

    return PASS;
  };
}

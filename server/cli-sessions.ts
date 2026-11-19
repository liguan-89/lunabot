// `lunabot devices` / `lunabot sessions`: list, revoke, and where one paired device may connect from. Moved out of
// server/cli.ts, which the file-size ratchet holds to its count.
import { formatSessions } from "./cli-pairing.ts";
import { cliCommand } from "./cli-invocation.ts";
import type { CliOptions } from "./cli.ts";

/** What this command needs from the CLI: the loopback call and its two shared refusals. */
export interface SessionsCommandDeps {
  api(port: number, path: string, init?: { method?: string; body?: string }): Promise<{ status: number; body: any }>;
  serverUp(port: number): Promise<boolean>;
  refusedAsService(status: number, body: any): boolean;
  serviceTrustHelp: string;
}

export function createSessionsCommand(deps: SessionsCommandDeps) {
  return async function runSessions(options: CliOptions): Promise<number> {
    if (!(await deps.serverUp(options.port))) {
      console.error(`no Luna Bot server on http://127.0.0.1:${options.port}`);
      return 1;
    }
    if (options.revoke) {
      const { status, body } = await deps.api(options.port, `/api/auth/sessions/${encodeURIComponent(options.revoke)}`, { method: "DELETE" });
      if (deps.refusedAsService(status, body)) {
        console.error(deps.serviceTrustHelp);
        return 1;
      }
      if (status !== 200) {
        console.error(`could not revoke: ${typeof body?.error === "string" ? body.error : status}`);
        return 1;
      }
      console.log(`revoked ${options.revoke}: that device is signed out and its stream is closed`);
      return 0;
    }
    if (options.routes) {
      const { status, body } = await deps.api(options.port, `/api/auth/sessions/${encodeURIComponent(options.routes.id)}/routes`, {
        method: "PUT",
        body: JSON.stringify({ routes: options.routes.routes }),
      });
      if (deps.refusedAsService(status, body)) {
        console.error(deps.serviceTrustHelp);
        return 1;
      }
      if (status !== 200) {
        console.error(`could not change where that device connects from: ${typeof body?.error === "string" ? body.error : status}`);
        return 1;
      }
      console.log(options.routes.routes === "local"
        ? `${options.routes.id} now connects from this machine's own networks only (Wi-Fi and tailnet); its relay sessions are closed`
        : `${options.routes.id} may connect from anywhere again`);
      return 0;
    }
    const { status, body } = await deps.api(options.port, "/api/auth/sessions");
    if (deps.refusedAsService(status, body)) {
      console.error(deps.serviceTrustHelp);
      return 1;
    }
    if (status !== 200) {
      console.error(`could not list sessions: ${typeof body?.error === "string" ? body.error : status}`);
      return 1;
    }
    const sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number; routes?: "any" | "local" }> = Array.isArray(body?.sessions) ? body.sessions : [];
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return 0;
    }
    if (!sessions.length) {
      console.log(`no paired devices yet: run ${cliCommand("pair")}`);
      return 0;
    }
    console.log(formatSessions(sessions));
    return 0;
  };
}

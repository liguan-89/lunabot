// Ports for suites that boot real servers: probe first, so two suites at once never lose an unchecked bind.
import { createServer } from "node:http";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";
import { ephemeralFloor, forWorker } from "./worker-port.ts";

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** A base of this worker where every `base + offset` is free (the harness also opens a webhook receiver one above
 * itself). A probe, not a reservation: the ports are released before they are returned. A range too narrow to share is
 * one a suite keeps to itself. */
export async function freePortBlock(offsets: number[], from = 19_600, span = 3_000): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const picked = from + Math.floor(Math.random() * span);
    const base = span < 64 ? picked : forWorker(picked);
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset)));
    if (checks.every(Boolean)) return base;
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${from}..${from + span}`);
}

/** A pre-registered sign-in app returns to one loopback port derived from the URL (mcpOAuthRedirectUri).
 * On Linux the top of 20000-39999 is the ephemeral range, held by client connections and TIME_WAIT, so
 * a query moves the derived port below it. */
export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await isFree(port)) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}

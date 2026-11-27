// POST /api/me/export builds a zip of everything the signed-in Team Cloud member carries out (member-export.ts) and
// answers an id; GET /api/me/export/<id> streams it back, once per person at a time, expired after ten minutes. The
// zip is written on disk first because attachments can be large; it is the member's alone, never another session's.
import { createReadStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeMemberExport, type MemberExportDeps } from "../member-export.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

const EXPIRES_MS = 10 * 60 * 1000;
const DOWNLOAD = /^\/api\/me\/export\/([\w-]{36})\.zip$/;

interface Artifact {
  owner: string;
  path: string;
  expires: number;
  bytes: number;
}

export interface MeExportRouteDeps extends MemberExportDeps {
  session(auth: RequestAuth): SessionRecord | null;
}

export function createMeExportRoutes(deps: MeExportRouteDeps): RouteHandler {
  const artifacts = new Map<string, Artifact>();
  const root = join(deps.dataDir, ".member-exports");
  function sweep() {
    for (const [id, artifact] of artifacts) {
      if (artifact.expires > Date.now()) continue;
      try { unlinkSync(artifact.path); } catch {}
      artifacts.delete(id);
    }
  }
  return async ({ res, path, method, auth, json }) => {
    const download = DOWNLOAD.exec(path);
    if (path !== "/api/me/export" && !download) return PASS;
    const session = deps.session(auth);
    if (!session) return json(res, 403, { error: "Sign in to this team to export your data." });
    const person = personKey(session);
    sweep();
    if (download) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const artifact = artifacts.get(download[1]);
      if (!artifact || artifact.owner !== person || !existsSync(artifact.path)) {
        return json(res, 404, { error: "This export has expired. Start it again." });
      }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": artifact.bytes,
        "content-disposition": `attachment; filename="lunabot-my-data.zip"`,
        "cache-control": "no-store",
      });
      return new Promise((resolvePromise) => {
        createReadStream(artifact.path).pipe(res).on("finish", () => resolvePromise(undefined)).on("error", () => resolvePromise(undefined));
      });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    for (const [id, artifact] of artifacts) {
      if (artifact.owner !== person) continue;
      try { unlinkSync(artifact.path); } catch {}
      artifacts.delete(id);
    }
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const file = join(root, `${id}.zip`);
      const entries = writeMemberExport(person, file, deps);
      const artifact: Artifact = { owner: person, path: file, expires: Date.now() + EXPIRES_MS, bytes: statSync(file).size };
      artifacts.set(id, artifact);
      return json(res, 200, { url: `/api/me/export/${id}.zip`, entries, bytes: artifact.bytes, expires: artifact.expires });
    } catch (error) {
      return json(res, 500, { error: `The export failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}

import { createReadStream } from "node:fs";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

import { randomBytesB64u, sha256Hex } from "./crypto.js";
import { sessions } from "./helpers.js";
import { bearer, HttpError, json, readBody } from "./http.js";
import { verifyHomeCall } from "./machines.js";

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

export async function handleIncludedPages(ctx) {
  for (const entry of routes) {
    if (entry.method !== ctx.method) continue;
    const match = typeof entry.pattern === "string" ? (ctx.path === entry.pattern ? [] : null) : ctx.path.match(entry.pattern);
    if (!match) continue;
    await entry.handler(ctx, match);
    return true;
  }
  return false;
}

/** What a page may carry, and the account's quota. The client enforces the same numbers from the mint answer. */
const LIMITS = { pages: 25, bytes: 4 * 1024 * 1024, files: 20, perHour: 30 };
const ACCESS_DAYS = 30;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const UPLOAD_LIMIT = LIMITS.bytes + 256 * 1024;
const PAGE_ID = /^p_[A-Za-z0-9_-]{12}$/;
const PAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const newPageId = () => `p_${randomBytesB64u(9)}`;

/** Either side of `pagesAccess` (`server/pages/access.ts`): a desktop's `omb_pd_` bearer, or a home's machine signature. */
function pagesAccount(ctx) {
  const token = bearer(ctx.req);
  if (token?.startsWith("omb_pd_")) {
    const access = ctx.store.pagesAccessByTokenHash(sha256Hex(token));
    if (!access || Number(access.expires_at) <= Date.now()) throw new HttpError(401, "invalid_token");
    return access.account_id;
  }
  return verifyHomeCall(ctx, "omb-pages-v1").account_id;
}

/** The desktop's sign-in trades its session for a bearer it hands to the local server (`lunabot:included-pages`). */
route("POST", "/api/cloud/desktop/services/pages", async (ctx) => {
  const session = sessions(ctx);
  const token = `omb_pd_${randomBytesB64u(32)}`;
  ctx.store.insertPagesAccess({
    accountId: session.account_id,
    tokenHash: sha256Hex(token),
    expiresAt: Date.now() + ACCESS_DAYS * 24 * 60 * 60 * 1000,
  });
  json(ctx.res, 200, {
    cloudContractVersion: 1,
    url: `${ctx.config.origin}/api/cloud/pages/token`,
    token,
  });
});

route("POST", "/api/cloud/pages/token", async (ctx) => {
  const accountId = pagesAccount(ctx);
  const action = ctx.body.action;
  if (action !== "create" && action !== "update" && action !== "delete") throw new HttpError(400, "invalid_request");
  const mints = ctx.store.pageUploadCount(accountId, Date.now() - 60 * 60 * 1000);
  if (mints >= LIMITS.perHour) throw new HttpError(429, "rate_limited", { message: "You've published a lot this hour. Try again in a few minutes." });
  let pageId;
  if (action === "create") {
    const count = ctx.store.pageCount(accountId);
    if (count >= LIMITS.pages) {
      throw new HttpError(402, "pages_limit", {
        message: "This account's pages are used up.",
        usage: { pages: count, limit: LIMITS.pages },
        upgrade: false,
      });
    }
    pageId = newPageId();
    ctx.store.insertPage({ id: pageId, accountId });
  } else {
    pageId = PAGE_ID.test(ctx.body.pageId ?? "") ? ctx.body.pageId : null;
    const page = pageId ? ctx.store.page(pageId) : null;
    if (!page || page.account_id !== accountId) throw new HttpError(404, "not_found");
  }
  const token = `omb_pu_${randomBytesB64u(32)}`;
  ctx.store.insertPageUpload({
    tokenHash: sha256Hex(token),
    accountId,
    pageId,
    action,
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  });
  json(ctx.res, 200, {
    token,
    pageId,
    uploadUrl: ctx.config.origin,
    pageUrl: `${ctx.config.origin}/p/${pageId}`,
    limits: { pages: LIMITS.pages, bytes: LIMITS.bytes, files: LIMITS.files, perHour: LIMITS.perHour },
  });
});

const validPagePath = (value) =>
  typeof value === "string" && PAGE_PATH.test(value) && !value.split("/").includes("..") && !value.endsWith("/");

/** The uploader's multipart body: `manifest` JSON plus one `f<index>` part per entry of `manifest.files`. */
function parseUpload(raw, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(String(contentType ?? ""));
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) throw new HttpError(400, "invalid_upload");
  const delimiter = Buffer.from(`--${marker}`);
  const parts = [];
  let start = raw.indexOf(delimiter);
  while (start >= 0) {
    start += delimiter.length;
    if (raw[start] === 0x2d && raw[start + 1] === 0x2d) break;
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
    const next = raw.indexOf(delimiter, start);
    if (next < 0) break;
    const headEnd = raw.indexOf("\r\n\r\n", start);
    if (headEnd < 0 || headEnd + 4 > next) throw new HttpError(400, "invalid_upload");
    const disposition = /name="([^"]{1,64})"/.exec(raw.subarray(start, headEnd).toString("latin1"));
    parts.push({ name: disposition?.[1] ?? "", data: raw.subarray(headEnd + 4, next - 2) });
    start = next;
  }
  const manifestPart = parts.find((part) => part.name === "manifest");
  if (!manifestPart) throw new HttpError(400, "invalid_upload");
  let manifest;
  try {
    manifest = JSON.parse(manifestPart.data.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_upload");
  }
  const listed = Array.isArray(manifest?.files) ? manifest.files : [];
  const files = listed.map((entry, index) => {
    const part = parts.find((candidate) => candidate.name === `f${index}`);
    if (!part || !validPagePath(entry?.path) || part.data.length !== Number(entry?.size)) throw new HttpError(400, "invalid_upload");
    return { path: entry.path, data: part.data };
  });
  if (!files.length) throw new HttpError(400, "invalid_upload");
  return { title: String(manifest.title ?? "").slice(0, 200), files };
}

/** `PUT|DELETE /v1/pages/<id>`: the minted upload token names the page and the action it was minted for. */
export async function handlePageIo(ctx) {
  const match = ctx.path.match(/^\/v1\/pages\/(p_[A-Za-z0-9_-]{12})$/);
  if (!match) throw new HttpError(404, "not_found");
  const pageId = match[1];
  const token = bearer(ctx.req);
  const upload = token ? ctx.store.pageUploadByTokenHash(sha256Hex(token)) : null;
  if (!upload || upload.page_id !== pageId || Number(upload.expires_at) <= Date.now()) throw new HttpError(401, "invalid_token");
  const dir = normalize(join(ctx.config.pagesDir, pageId));
  if (ctx.method === "DELETE") {
    if (upload.action !== "delete") throw new HttpError(403, "wrong_action");
    rmSync(dir, { recursive: true, force: true });
    ctx.store.deletePage(pageId);
    json(ctx.res, 200, { ok: true, usage: { pages: ctx.store.pageCount(upload.account_id), limit: LIMITS.pages } });
    return true;
  }
  if (ctx.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  if (upload.action === "delete") throw new HttpError(403, "wrong_action");
  const { title, files } = parseUpload(await readBody(ctx.req, UPLOAD_LIMIT), ctx.req.headers["content-type"]);
  if (files.length > LIMITS.files) throw new HttpError(413, "too_many_files");
  const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (bytes > LIMITS.bytes) throw new HttpError(413, "page_too_large");
  rmSync(dir, { recursive: true, force: true });
  for (const file of files) {
    const target = normalize(join(dir, file.path));
    if (!target.startsWith(dir + sep)) throw new HttpError(400, "invalid_upload");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
  ctx.store.updatePage(pageId, { title, bytes, files: files.length });
  json(ctx.res, 200, { ok: true, usage: { pages: ctx.store.pageCount(upload.account_id), limit: LIMITS.pages }, badge: false });
  return true;
}

const PAGE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * `GET /p/<id>/<file>`: published pages are bot-authored HTML anyone may open, so the reply sandboxes them —
 * the page's scripts run, but they share no origin, cookies or storage with the plane.
 */
export function servePage(res, config, path) {
  const rel = path.slice("/p/".length);
  const id = rel.split("/")[0];
  if (!PAGE_ID.test(id)) return false;
  const dir = normalize(join(config.pagesDir, id));
  let rest = rel.slice(id.length).replace(/^\//, "") || "index.html";
  if (rest.endsWith("/")) rest += "index.html";
  const file = normalize(join(dir, rest));
  if (!file.startsWith(dir + sep)) return false;
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  res.writeHead(200, {
    "content-type": PAGE_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": "public, max-age=60",
    "content-security-policy": "sandbox allow-scripts",
  });
  createReadStream(file).pipe(res);
  return true;
}

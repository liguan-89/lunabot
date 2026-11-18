export const BODY_LIMIT = 64 * 1024;

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

export function html(res, status, body, headers = {}) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(payload);
}

export function text(res, status, body, headers = {}) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}

export function fail(res, status, code, extra = {}) {
  return json(res, status, { error: code, ...extra });
}

export function methodNotAllowed(res, allow) {
  return json(res, 405, { error: "method_not_allowed" }, { allow });
}

export async function readJson(req, limit = BODY_LIMIT) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "request_too_large");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "request_too_large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_json");
  return value;
}

export function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer ([A-Za-z0-9._-]{20,8192})$/);
  return match ? match[1] : null;
}

export function setCors(req, res, origin) {
  if (req.headers.origin === origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-max-age", "600");
  }
}

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return {};
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** Fixed-window limiter, keyed by IP and by a second bucket (email or account). */
export class RateLimiter {
  constructor({ windowMs, limit }) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.buckets = new Map();
  }

  check(key) {
    const at = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) return false;
    bucket.count += 1;
    return true;
  }

  sweep() {
    const at = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= at) this.buckets.delete(key);
  }
}

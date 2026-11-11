import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";

import { handleAdmin, adminPlans } from "./admin.js";
import { handleControl } from "./control.js";
import { EmailUnavailable } from "./email.js";
import { PLANS } from "./helpers.js";
import { HttpError, RateLimiter, fail, html, json, methodNotAllowed, readJson, setCors, text } from "./http.js";
import { approvalPage, buyPage, downloadPage, errorPage, plansPage } from "./pages.js";
import { newUuid } from "./crypto.js";

const STATIC = { ".apk": "application/vnd.android.package-archive", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8" };

function staticResponse(res, path, { downloadName, immutable = false } = {}) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  const extension = path.slice(path.lastIndexOf("."));
  res.writeHead(200, {
    "content-type": STATIC[extension] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": immutable ? "public, max-age=86400" : "public, max-age=300",
    ...(downloadName ? { "content-disposition": `attachment; filename="${downloadName}"` } : {}),
  });
  createReadStream(path).pipe(res);
  return true;
}

function updateManifest(config) {
  let sha256;
  let size;
  try {
    const stats = statSync(config.apkPath);
    size = stats.size;
    sha256 = createHash("sha256").update(readFileSync(config.apkPath)).digest("hex");
  } catch {
    sha256 = undefined;
    size = undefined;
  }
  return JSON.stringify({
    versionCode: 20000,
    versionName: config.latestVersion,
    apkUrl: "/download/dexbot.apk",
    notes: "DEX BOT 2.0.0 · 自建 DEX Cloud，支持与官方版同时安装",
    ...(size ? { size } : {}),
    ...(sha256 ? { sha256 } : {}),
  });
}

function planFromCheckout(store, checkoutId) {
  const checkout = checkoutId ? store.checkout(checkoutId) : null;
  if (!checkout) return null;
  return { checkout, plan: PLANS.find((plan) => plan.tier === checkout.plan) ?? null };
}

export function createApp({ config, store, emailer, relayKey, log = console.log }) {
  const limits = {
    authorizeIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 120 }),
    tokenIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 2000 }),
    otpIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 30 }),
    otpEmail: new RateLimiter({ windowMs: 15 * 60_000, limit: 10 }),
    checkoutIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 30 }),
  };
  const sweeper = setInterval(() => {
    for (const limiter of Object.values(limits)) limiter.sweep();
    store.purgeDeviceCodes(Date.now());
    store.purgeEmailAttempts(Date.now());
  }, 60 * 60_000);
  sweeper.unref?.();

  return async function handle(req, res) {
    const requestId = newUuid();
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    setCors(req, res, config.origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    let url;
    try {
      url = new URL(req.url ?? "/", config.origin);
    } catch {
      return fail(res, 400, "invalid_request");
    }
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (path.startsWith("/api/") || path.startsWith("/v1/") || path === "/healthz") {
        const body = method === "GET" || method === "HEAD" ? {} : await readJson(req);
        const ctx = {
          req, res, method, path, url, body, config, store, emailer, relayKey, log, limits,
          ip: req.socket.remoteAddress ?? "0.0.0.0",
        };
        if (path.startsWith("/api/")) {
          const forwarded = req.headers["x-forwarded-for"];
          const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0].trim();
          if (first) ctx.ip = first;
        }
        if (await handleAdmin(ctx)) return;
        if (await handleControl(ctx)) return;
        return fail(res, 404, "not_found");
      }

      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");

      if (path === "/" || path === "/download") return html(res, 200, downloadPage(config));
      if (path === "/pricing") {
        res.writeHead(303, { location: "/cloud" });
        return res.end();
      }
      if (path === "/cloud") return html(res, 200, plansPage(config, adminPlans()));
      if (path === "/cloud/desktop") return html(res, 200, approvalPage(url.searchParams.get("code") ?? "", config));
      if (path === "/pro/buy") {
        const found = planFromCheckout(store, url.searchParams.get("checkout"));
        if (!found?.plan) return html(res, 404, errorPage("订单不存在或已过期。"));
        if (found.checkout.status === "complete") return html(res, 200, buyPage(found.checkout.id, found.plan, config));
        return html(res, 200, buyPage(found.checkout.id, found.plan, config));
      }
      if (path === "/cloud/return") return html(res, 200, errorPage("已收到。回到 DEX BOT 即可看到最新的账号状态。"));
      if (path === "/download/dexbot.apk") {
        if (staticResponse(res, config.apkPath, { downloadName: "dexbot.apk", immutable: true })) return;
        return html(res, 404, errorPage("APK 还没有上传到这个服务器。"));
      }
      if (path === "/update.json") {
        if (existsSync(config.updatePath) && staticResponse(res, config.updatePath)) return;
        return json(res, 200, JSON.parse(updateManifest(config)));
      }
      if (path === "/landing" && existsSync(config.landingPath)) {
        if (staticResponse(res, config.landingPath)) return;
      }
      return text(res, 404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(res, error.status, error.code, error.extra);
      }
      if (error instanceof EmailUnavailable) {
        log(`email unavailable: ${error.message}`);
        return fail(res, 501, "email_unavailable");
      }
      log(`request failed (${requestId}): ${error?.message ?? "unknown"}`);
      if (!res.headersSent) return fail(res, 500, "internal_error");
      res.end();
    }
  };
}

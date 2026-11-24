import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { handleAdmin, adminPlans } from "./admin.js";
import { handleControl } from "./control.js";
import { EmailUnavailable } from "./email.js";
import { PLANS } from "./helpers.js";
import { HttpError, RateLimiter, fail, html, json, methodNotAllowed, readJsonRaw, setCors, text } from "./http.js";
import { handleIncludedPages, handlePageIo, servePage } from "./included-pages.js";
import { handleMachines } from "./machines.js";
import { approvalPage, buyPage, docsPage, downloadPage, errorPage, feedbackPage, plansPage, provisionPage } from "./pages.js";
import { newUuid } from "./crypto.js";

const STATIC = {
  ".apk": "application/vnd.android.package-archive",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".blockmap": "application/octet-stream",
  ".appimage": "application/octet-stream",
  ".deb": "application/vnd.debian.binary-package",
};
/** electron-updater sends a report up to 600 KB, larger than the 64 KB JSON limit of every other route. */
const BUG_REPORT_BODY_LIMIT = 640 * 1024;
const DESKTOP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function staticResponse(res, path, { downloadName, immutable = false } = {}) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  res.writeHead(200, {
    "content-type": STATIC[extension] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": immutable ? "public, max-age=86400" : "public, max-age=300",
    ...(downloadName ? { "content-disposition": `attachment; filename="${downloadName}"` } : {}),
  });
  createReadStream(path).pipe(res);
  return true;
}

/** Android computes `MAJOR*10000+MINOR*100+PATCH` (`android/app/build.gradle.kts`): a fixed literal under a newer
 * release answers "already latest" forever. Fall back to it only when the name cannot be parsed. */
function versionCodeOf(versionName) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionName ?? ""));
  return match ? Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]) : 20_000;
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
    versionCode: versionCodeOf(config.latestVersion),
    versionName: config.latestVersion,
    apkUrl: "/download/lunabot.apk",
    notes: `Luna Bot ${config.latestVersion} · 自建 Luna Bot Cloud，支持与官方版同时安装`,
    ...(size ? { size } : {}),
    ...(sha256 ? { sha256 } : {}),
  });
}

function planFromCheckout(store, checkoutId) {
  const checkout = checkoutId ? store.checkout(checkoutId) : null;
  if (!checkout) return null;
  return { checkout, plan: PLANS.find((plan) => plan.tier === checkout.plan) ?? null };
}

/** The installers and updater feeds in the desktop directory, newest first. Names only: never a path. */
function desktopFiles(config) {
  let names;
  try {
    names = readdirSync(config.desktopDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => DESKTOP_FILE.test(name))
    .flatMap((name) => {
      try {
        const stats = statSync(join(config.desktopDir, name));
        return stats.isFile() ? [{ name, size: stats.size, at: stats.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at - a.at)
    .map(({ name, size }) => ({ name, size }));
}

export function createApp({ config, store, emailer, relayKey, provisioner, log = console.log }) {
  const limits = {
    authorizeIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 120 }),
    tokenIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 2000 }),
    otpIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 30 }),
    otpEmail: new RateLimiter({ windowMs: 15 * 60_000, limit: 10 }),
    checkoutIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 30 }),
    bugIp: new RateLimiter({ windowMs: 60 * 60_000, limit: 20 }),
  };
  const sweep = () => {
    for (const limiter of Object.values(limits)) limiter.sweep();
    store.purgeDeviceCodes(Date.now());
    store.purgeEmailAttempts(Date.now());
    // A phone that has not reported for a week is a reinstall, a spare, or an
    // emulator left behind; its row is noise in 我的电脑 and in the account list.
    if (config.stalePhoneDays > 0) {
      const dropped = store.purgeStalePhones(Date.now() - config.stalePhoneDays * 24 * 60 * 60_000);
      if (dropped) log(`swept ${dropped} stale phone installation(s)`);
    }
    store.purgePageUploads(Date.now());
    store.purgePagesAccess(Date.now());
    store.purgeEmptyPages(Date.now() - 60 * 60_000);
  };
  // Once at startup as well as hourly: a deploy that ships a new rule should not
  // leave the old rows sitting for an hour before anything happens to them.
  sweep();
  const sweeper = setInterval(sweep, 60 * 60_000);
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
      if (path === "/internal/tls-ask") {
        const domain = String(url.searchParams.get("domain") ?? "").toLowerCase();
        const cloud = domain ? store.cloudByHostname(domain) : null;
        if (cloud && cloud.status !== "ended") {
          res.writeHead(200);
          return res.end("ok");
        }
        res.writeHead(404);
        return res.end("unknown");
      }
      if (path.startsWith("/api/") || path.startsWith("/v1/") || path === "/healthz") {
        // Page uploads are multipart, not JSON: their handler reads the stream itself.
        const isPageIo = path.startsWith("/v1/pages/");
        const { body, raw } = method === "GET" || method === "HEAD" || isPageIo
          ? { body: {}, raw: Buffer.alloc(0) }
          : await readJsonRaw(req, path === "/api/bug-reports" ? BUG_REPORT_BODY_LIMIT : undefined);
        const ctx = {
          req, res, method, path, url, body, rawBody: raw, config, store, emailer, relayKey, provisioner, log, limits,
          ip: req.socket.remoteAddress ?? "0.0.0.0",
        };
        if (path.startsWith("/api/")) {
          const forwarded = req.headers["x-forwarded-for"];
          const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0].trim();
          if (first) ctx.ip = first;
        }
        if (isPageIo) {
          if (await handlePageIo(ctx)) return;
        } else {
          if (await handleAdmin(ctx)) return;
          if (await handleControl(ctx)) return;
          if (await handleMachines(ctx)) return;
          if (await handleIncludedPages(ctx)) return;
        }
        return fail(res, 404, "not_found");
      }

      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, "GET, HEAD");

      if (path === "/" || path === "/download") return html(res, 200, downloadPage(config, desktopFiles(config)));
      if (path === "/docs" || path === "/help" || /^\/docs\/[a-z-]{1,32}$/.test(path)) return html(res, 200, docsPage(config));
      if (path === "/feedback" || path === "/issues") return html(res, 200, feedbackPage(config));
      if (path === "/troubleshooting") {
        res.writeHead(303, { location: "/docs#troubleshooting" });
        return res.end();
      }
      if (path.startsWith("/desktop/")) {
        const name = decodeURIComponent(path.slice("/desktop/".length));
        if (!DESKTOP_FILE.test(name)) return text(res, 404, "Not found");
        if (staticResponse(res, join(config.desktopDir, name), { immutable: /^latest.*\.yml$/.test(name) === false })) return;
        return text(res, 404, "Not found");
      }
      if (path.startsWith("/p/")) {
        if (servePage(res, config, path)) return;
        return text(res, 404, "Not found");
      }
      if (path === "/cloud") return html(res, 200, plansPage(config, adminPlans()));
      if (path === "/pricing") {
        res.writeHead(303, { location: "/cloud" });
        return res.end();
      }
      if (path === "/cloud/desktop") return html(res, 200, approvalPage(url.searchParams.get("code") ?? "", config));
      if (path === "/pro/buy") {
        const found = planFromCheckout(store, url.searchParams.get("checkout"));
        if (!found?.plan) return html(res, 404, errorPage("订单不存在或已过期。"));
        if (found.checkout.status === "complete") return html(res, 200, buyPage(found.checkout.id, found.plan, config));
        return html(res, 200, buyPage(found.checkout.id, found.plan, config));
      }
      if (path === "/cloud/return") return html(res, 200, errorPage("已收到。回到 Luna Bot 即可看到最新的账号状态。"));
      if (path === "/provision") {
        const cloud = store.cloud(String(url.searchParams.get("cloud") ?? ""));
        if (!cloud) return html(res, 404, errorPage("云电脑不存在或已被移除。"));
        return html(res, 200, provisionPage(cloud));
      }
      if (path === "/download/lunabot.apk") {
        if (staticResponse(res, config.apkPath, { downloadName: "lunabot.apk", immutable: true })) return;
        return html(res, 404, errorPage("APK 还没有上传到这个服务器。"));
      }
      if (path === "/download/dexbot.apk") {
        res.writeHead(303, { location: `/download/lunabot.apk${url.search}` });
        return res.end();
      }
      if (path === "/update.json") {
        if (existsSync(config.updatePath) && staticResponse(res, config.updatePath)) return;
        return json(res, 200, JSON.parse(updateManifest(config)));
      }
      if (path === "/og.png") {
        if (staticResponse(res, config.ogPath, { immutable: true })) return;
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

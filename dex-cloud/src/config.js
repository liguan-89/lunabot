import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const trim = (value) => String(value ?? "").trim();

const int = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const bool = (value, fallback = false) =>
  value === undefined ? fallback : /^(?:1|true|yes|on)$/i.test(trim(value));

const list = (value) =>
  trim(value).split(",").map((item) => item.trim()).filter(Boolean);

const origin = (value, fallback) => {
  const text = trim(value) || fallback;
  const url = new URL(text);
  if (url.protocol !== "https:" || url.origin !== text || url.username || url.password) {
    throw new Error(`DEXCLOUD_ORIGIN must be a bare https origin, got ${text}`);
  }
  return text;
};

const smtp = (value) => {
  const text = trim(value);
  if (!text) return null;
  const url = new URL(text);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("DEXCLOUD_SMTP_URL must start with smtp:// or smtps://");
  }
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "smtps:" ? 465 : 25),
    user: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    secure: url.protocol === "smtps:" || /[?&]secure=1\b/.test(url.search),
  };
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.DEXCLOUD_PORT, 8791, { min: 1, max: 65535 }),
    host: trim(env.DEXCLOUD_HOST) || "127.0.0.1",
    origin: origin(env.DEXCLOUD_ORIGIN, "https://cloud.dexai.vip"),
    dbPath: trim(env.DEXCLOUD_DB) || "/data/dex-cloud.db",
    trustProxy: bool(env.DEXCLOUD_TRUST_PROXY, true),
    devCodes: bool(env.DEXCLOUD_DEV_CODES, false),
    signupOpen: bool(env.DEXCLOUD_SIGNUP_OPEN, true),
    sessionDays: int(env.DEXCLOUD_SESSION_DAYS, 30, { min: 1, max: 365 }),
    otpTtlSeconds: int(env.DEXCLOUD_OTP_TTL_SECONDS, 600, { min: 60, max: 3600 }),
    otpResendSeconds: int(env.DEXCLOUD_OTP_RESEND_SECONDS, 30, { min: 5, max: 600 }),
    emailFrom: trim(env.DEXCLOUD_EMAIL_FROM) || "DEX BOT <noreply@cloud.dexai.vip>",
    smtp: smtp(env.DEXCLOUD_SMTP_URL),
    resendKey: trim(env.DEXCLOUD_RESEND_API_KEY),
    relayNodes: list(env.DEXCLOUD_RELAY_NODES).length ? list(env.DEXCLOUD_RELAY_NODES) : ["relay1.dexai.vip"],
    relayKid: trim(env.DEXCLOUD_RELAY_TOKEN_KID) || "k1",
    relaySeed: trim(env.DEXCLOUD_RELAY_TOKEN_SEED),
    planMode: trim(env.DEXCLOUD_PLAN_MODE) || "pro",
    adminEmails: list(env.DEXCLOUD_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    latestVersion: trim(env.DEXCLOUD_LATEST_VERSION) || "2.0.0",
    apkPath: trim(env.DEXCLOUD_APK_PATH) || "/data/downloads/dexbot.apk",
    updatePath: trim(env.DEXCLOUD_UPDATE_PATH) || "/data/downloads/update.json",
    landingPath: trim(env.DEXCLOUD_LANDING_PATH) || "/data/downloads/landing.html",
    /** The share/OG card, bundled beside this module and served at /og.png. */
    ogPath: trim(env.DEXCLOUD_OG_PATH) || fileURLToPath(new URL("./assets/og.png", import.meta.url)),
    /** Desktop installers and electron-updater feeds (`latest-mac.yml`, …), served under `/desktop/`. */
    desktopDir: trim(env.DEXCLOUD_DESKTOP_DIR) || "/data/downloads/desktop",
    dockerSocket: trim(env.DEXCLOUD_DOCKER_SOCKET) || "/var/run/docker.sock",
    cloudImage: trim(env.DEXCLOUD_CLOUD_IMAGE) || "dexbot-cloud-home:local",
    cloudNetwork: trim(env.DEXCLOUD_CLOUD_NETWORK) || "dexcloud",
    cloudHostSuffix: trim(env.DEXCLOUD_CLOUD_HOST_SUFFIX) || "cloud.dexai.vip",
    cloudMemoryMb: int(env.DEXCLOUD_CLOUD_MEMORY_MB, 1536, { min: 512, max: 8192 }),
    cloudNanoCpus: int(env.DEXCLOUD_CLOUD_NANO_CPUS, 1_500_000_000, { min: 0, max: 8_000_000_000 }),
    cloudDiskGb: int(env.DEXCLOUD_CLOUD_DISK_GB, 10, { min: 1, max: 100 }),
    cloudMaxDiskGb: int(env.DEXCLOUD_CLOUD_MAX_DISK_GB, 20, { min: 1, max: 200 }),
    cloudMaxPerAccount: int(env.DEXCLOUD_CLOUD_MAX_PER_ACCOUNT, 1, { min: 0, max: 20 }),
    cloudProvisionTimeoutMs: int(env.DEXCLOUD_CLOUD_PROVISION_TIMEOUT_MS, 180_000, { min: 30_000, max: 600_000 }),
    routerPort: int(env.DEXCLOUD_ROUTER_PORT, 8792, { min: 1, max: 65535 }),
  };
}

export function loadRelaySeed(config, readFile = (path) => readFileSync(path, "utf8")) {
  if (!config.relaySeed) throw new Error("DEXCLOUD_RELAY_TOKEN_SEED is required");
  const seed = config.relaySeed.startsWith("file:")
    ? trim(readFile(config.relaySeed.slice(5)))
    : config.relaySeed;
  if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) {
    throw new Error("DEXCLOUD_RELAY_TOKEN_SEED must be a base64url 32-byte Ed25519 seed");
  }
  return seed;
}

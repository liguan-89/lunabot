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
    throw new Error(`LUNABOT_CLOUD_ORIGIN must be a bare https origin, got ${text}`);
  }
  return text;
};

const smtp = (value) => {
  const text = trim(value);
  if (!text) return null;
  const url = new URL(text);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("LUNABOT_CLOUD_SMTP_URL must start with smtp:// or smtps://");
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
    port: int(env.LUNABOT_CLOUD_PORT, 8791, { min: 1, max: 65535 }),
    host: trim(env.LUNABOT_CLOUD_HOST) || "127.0.0.1",
    origin: origin(env.LUNABOT_CLOUD_ORIGIN, "https://cloud.dexai.vip"),
    dbPath: trim(env.LUNABOT_CLOUD_DB) || "/data/dex-cloud.db",
    trustProxy: bool(env.LUNABOT_CLOUD_TRUST_PROXY, true),
    devCodes: bool(env.LUNABOT_CLOUD_DEV_CODES, false),
    signupOpen: bool(env.LUNABOT_CLOUD_SIGNUP_OPEN, true),
    sessionDays: int(env.LUNABOT_CLOUD_SESSION_DAYS, 30, { min: 1, max: 365 }),
    otpTtlSeconds: int(env.LUNABOT_CLOUD_OTP_TTL_SECONDS, 600, { min: 60, max: 3600 }),
    otpResendSeconds: int(env.LUNABOT_CLOUD_OTP_RESEND_SECONDS, 30, { min: 5, max: 600 }),
    emailFrom: trim(env.LUNABOT_CLOUD_EMAIL_FROM) || "Luna Bot <noreply@cloud.dexai.vip>",
    smtp: smtp(env.LUNABOT_CLOUD_SMTP_URL),
    resendKey: trim(env.LUNABOT_CLOUD_RESEND_API_KEY),
    // `cloud.dexai.vip` serves the relay routes itself, so a deployment that sets nothing still issues a node a phone
    // can reach. A bare `relayN.dexai.vip` name needs its own Caddy site block; without one the TLS handshake fails and
    // the grant is useless.
    relayNodes: list(env.LUNABOT_CLOUD_RELAY_NODES).length ? list(env.LUNABOT_CLOUD_RELAY_NODES) : ["cloud.dexai.vip"],
    relayKid: trim(env.LUNABOT_CLOUD_RELAY_TOKEN_KID) || "k1",
    relaySeed: trim(env.LUNABOT_CLOUD_RELAY_TOKEN_SEED),
    /** Phone installations silent this long are swept; 0 keeps them forever. */
    stalePhoneDays: int(env.LUNABOT_CLOUD_STALE_PHONE_DAYS, 7, { min: 0, max: 365 }),
    planMode: trim(env.LUNABOT_CLOUD_PLAN_MODE) || "pro",
    adminEmails: list(env.LUNABOT_CLOUD_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    latestVersion: trim(env.LUNABOT_CLOUD_LATEST_VERSION) || "2.0.0",
    apkPath: trim(env.LUNABOT_CLOUD_APK_PATH) || "/data/downloads/dexbot.apk",
    updatePath: trim(env.LUNABOT_CLOUD_UPDATE_PATH) || "/data/downloads/update.json",
    landingPath: trim(env.LUNABOT_CLOUD_LANDING_PATH) || "/data/downloads/landing.html",
    /** The share/OG card, bundled beside this module and served at /og.png. */
    ogPath: trim(env.LUNABOT_CLOUD_OG_PATH) || fileURLToPath(new URL("./assets/og.png", import.meta.url)),
    /** Desktop installers and electron-updater feeds (`latest-mac.yml`, …), served under `/desktop/`. */
    desktopDir: trim(env.LUNABOT_CLOUD_DESKTOP_DIR) || "/data/downloads/desktop",
    dockerSocket: trim(env.LUNABOT_CLOUD_DOCKER_SOCKET) || "/var/run/docker.sock",
    cloudImage: trim(env.LUNABOT_CLOUD_CLOUD_IMAGE) || "lunabot-cloud-home:local",
    cloudNetwork: trim(env.LUNABOT_CLOUD_CLOUD_NETWORK) || "dexcloud",
    cloudHostSuffix: trim(env.LUNABOT_CLOUD_CLOUD_HOST_SUFFIX) || "cloud.dexai.vip",
    cloudMemoryMb: int(env.LUNABOT_CLOUD_CLOUD_MEMORY_MB, 1536, { min: 512, max: 8192 }),
    cloudNanoCpus: int(env.LUNABOT_CLOUD_CLOUD_NANO_CPUS, 1_500_000_000, { min: 0, max: 8_000_000_000 }),
    cloudDiskGb: int(env.LUNABOT_CLOUD_CLOUD_DISK_GB, 10, { min: 1, max: 100 }),
    cloudMaxDiskGb: int(env.LUNABOT_CLOUD_CLOUD_MAX_DISK_GB, 20, { min: 1, max: 200 }),
    cloudMaxPerAccount: int(env.LUNABOT_CLOUD_CLOUD_MAX_PER_ACCOUNT, 1, { min: 0, max: 20 }),
    cloudProvisionTimeoutMs: int(env.LUNABOT_CLOUD_CLOUD_PROVISION_TIMEOUT_MS, 180_000, { min: 30_000, max: 600_000 }),
    routerPort: int(env.LUNABOT_CLOUD_ROUTER_PORT, 8792, { min: 1, max: 65535 }),
  };
}

export function loadRelaySeed(config, readFile = (path) => readFileSync(path, "utf8")) {
  if (!config.relaySeed) throw new Error("LUNABOT_CLOUD_RELAY_TOKEN_SEED is required");
  const seed = config.relaySeed.startsWith("file:")
    ? trim(readFile(config.relaySeed.slice(5)))
    : config.relaySeed;
  if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) {
    throw new Error("LUNABOT_CLOUD_RELAY_TOKEN_SEED must be a base64url 32-byte Ed25519 seed");
  }
  return seed;
}

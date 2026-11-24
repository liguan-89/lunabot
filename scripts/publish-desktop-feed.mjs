// Publishes one release to the DEX Cloud file feed and keeps only the newest
// version there. Desktop assets go to downloads/desktop/ (served under
// /desktop/*); the Android channel APK replaces downloads/lunabot.apk and its
// update.json is rewritten from the APK bytes. Old LUNABOT-<version>-* files
// and every *.bak-* backup are removed, so the server never accumulates
// history the GitHub release already keeps.
//
//   node scripts/publish-desktop-feed.mjs [--assets-dir release-assets] \
//     [--apk path/to/app-dist.apk] [--notes "release notes"] [--dry-run] \
//     [--no-cloud-home]
//
// --assets-dir must contain the assembled release set (the same files the
// GitHub release carries). --apk additionally publishes the Android channel;
// without it only the desktop feed is touched. Afterwards the Cloud home
// image on the same host is promoted to the release and running Clouds are
// rebuilt on it (--no-cloud-home skips that; promote-cloud-home.mjs is the
// same step on its own).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEED_BASE = process.env.LUNABOT_FEED_BASE || "https://cloud.dexai.vip";
const SSH_HOST = process.env.LUNABOT_PUBLISH_HOST || "wholesale";
const DATA_DIR = process.env.LUNABOT_PUBLISH_DATA_DIR || "/opt/dex-cloud/data";
const DESKTOP_DIR = `${DATA_DIR}/downloads/desktop`;
const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;

function fail(message) {
  console.error(`[publish-desktop-feed] ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const assetsDir = path.resolve(argValue("--assets-dir") ?? "release-assets");
const apkPath = argValue("--apk");
const notes = argValue("--notes") ?? "";

if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
  fail(`assets dir not found: ${assetsDir}`);
}
if (apkPath && !existsSync(path.resolve(apkPath))) fail(`APK not found: ${apkPath}`);

// The version comes from the DEB name; exactly one must exist so a stale or
// mixed directory cannot publish the wrong set.
const debs = readdirSync(assetsDir).filter((name) => /^LUNABOT-\d+\.\d+\.\d+-amd64\.deb$/.test(name));
if (debs.length !== 1) fail(`expected exactly one versioned DEB in ${assetsDir}, found ${debs.length}`);
const version = debs[0].slice("LUNABOT-".length, -"-amd64.deb".length);
const apkFeedName = `LUNABOT-${version}-android-arm64.apk`;

const FEED_FILES = [
  `LUNABOT-${version}-amd64.deb`,
  `LUNABOT-${version}-arm64.dmg`,
  `LUNABOT-${version}-arm64.dmg.blockmap`,
  `LUNABOT-${version}-arm64.zip`,
  `LUNABOT-${version}-arm64.zip.blockmap`,
  `LUNABOT-${version}-setup.exe`,
  `LUNABOT-${version}-setup.exe.blockmap`,
  apkFeedName,
  "LUNABOT-amd64.deb",
  "LUNABOT-setup.exe",
  "LUNABOT.dmg",
  "latest-linux.yml",
  "latest-mac.yml",
  "latest.yml",
  "SHA256SUMS-ubuntu-x64.txt",
];

const uploads = [];
for (const name of FEED_FILES) {
  // The channel APK doubles as the desktop feed's android-arm64 asset.
  const local = name === apkFeedName && apkPath
    ? path.resolve(apkPath)
    : path.join(assetsDir, name);
  if (!existsSync(local)) {
    if (name === apkFeedName && !apkPath) continue;
    fail(`missing release asset: ${name}`);
  }
  uploads.push({ local, remote: `${DESKTOP_DIR}/${name}` });
}

function ssh(command) {
  return execFileSync("ssh", [SSH_HOST, command], { encoding: "utf8" }).trim();
}

function remoteList(dir) {
  try {
    return ssh(`ls -1 ${dir}`).split("\n").filter(Boolean);
  } catch {
    fail(`cannot list ${dir} on ${SSH_HOST}`);
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSIONED_RE = /^LUNABOT-\d+\.\d+\.\d+-[A-Za-z0-9._-]+$/;
const BACKUP_RE = /^((?:dexbot|lunabot)\.apk|update\.json)\.bak-[A-Za-z0-9._-]+$/;
const uploadNames = new Set(uploads.map((u) => path.basename(u.remote)));

const desktopRemote = remoteList(DESKTOP_DIR);
const desktopDeletes = desktopRemote.filter(
  (name) => VERSIONED_RE.test(name) && SAFE_NAME.test(name) && !uploadNames.has(name),
);

const channelPlan = [];
if (apkPath) {
  const apk = path.resolve(apkPath);
  const [major, minor, patch] = version.split(".").map(Number);
  const versionCode = major * 10000 + minor * 100 + patch;
  const sha256 = createHash("sha256").update(readFileSync(apk)).digest("hex");
  const size = statSync(apk).size;
  const manifest = `${JSON.stringify({
    versionCode,
    versionName: version,
    apkUrl: `/download/lunabot.apk?v=${versionCode}`,
    notes,
    size,
    sha256,
  })}\n`;
  channelPlan.push(
    { local: apk, remote: `${DOWNLOADS_DIR}/lunabot.apk`, label: "channel APK" },
    { local: null, remote: `${DOWNLOADS_DIR}/update.json`, content: manifest, label: "update.json" },
  );
  for (const name of remoteList(DOWNLOADS_DIR)) {
    if (BACKUP_RE.test(name)) {
      channelPlan.push({ local: null, remote: `${DOWNLOADS_DIR}/${name}`, delete: true, label: "stale backup" });
    } else if (name === "dexbot.apk") {
      channelPlan.push({ local: null, remote: `${DOWNLOADS_DIR}/${name}`, delete: true, label: "legacy APK name" });
    }
  }
}

console.log(`[publish-desktop-feed] version ${version} → ${SSH_HOST}:${DESKTOP_DIR}${dryRun ? " (dry-run)" : ""}`);
for (const u of uploads) {
  console.log(`  ${desktopRemote.includes(path.basename(u.remote)) ? "keep " : "put  "} desktop/${path.basename(u.remote)}`);
}
for (const name of desktopDeletes) console.log(`  delete desktop/${name}`);
for (const item of channelPlan) {
  if (item.delete) console.log(`  delete downloads/${path.basename(item.remote)}`);
  else if (item.content) console.log(`  put   downloads/${path.basename(item.remote)}\n${item.content.trim()}`);
  else console.log(`  put   downloads/${path.basename(item.remote)}`);
}

if (dryRun) {
  console.log("[publish-desktop-feed] dry-run complete; nothing changed");
  process.exit(0);
}

for (const u of uploads) {
  execFileSync("rsync", ["-az", "--", u.local, `${SSH_HOST}:${u.remote}`], { stdio: "inherit" });
}
for (const name of desktopDeletes) {
  ssh(`rm -f -- ${DESKTOP_DIR}/${name}`);
}
for (const item of channelPlan) {
  if (item.delete) {
    ssh(`rm -f -- ${item.remote}`);
  } else if (item.content) {
    execFileSync("ssh", [SSH_HOST, `cat > ${item.remote}`], { input: item.content });
  } else {
    execFileSync("rsync", ["-az", "--", item.local, `${SSH_HOST}:${item.remote}`], { stdio: "inherit" });
  }
}

function fetchText(url) {
  try {
    return execFileSync("curl", ["-fsS", url], { encoding: "utf8" });
  } catch {
    fail(`feed check failed: ${url}`);
  }
}
for (const feed of ["latest-linux.yml", "latest-mac.yml", "latest.yml"]) {
  const body = fetchText(`${FEED_BASE}/desktop/${feed}`);
  if (!body.includes(version)) fail(`${feed} on the feed does not mention ${version}`);
  console.log(`[publish-desktop-feed] ${feed} serves ${version}`);
}
if (apkPath) {
  const manifest = JSON.parse(fetchText(`${FEED_BASE}/update.json`));
  const [major, minor, patch] = version.split(".").map(Number);
  if (manifest.versionCode !== major * 10000 + minor * 100 + patch) {
    fail(`update.json serves versionCode ${manifest.versionCode}, expected ${version}`);
  }
  console.log(`[publish-desktop-feed] update.json serves ${version} (versionCode ${manifest.versionCode})`);
}
console.log("[publish-desktop-feed] feed OK");

if (process.argv.includes("--no-cloud-home")) {
  console.log("[publish-desktop-feed] cloud-home promotion skipped (--no-cloud-home)");
} else {
  execFileSync(process.execPath, [fileURLToPath(new URL("./promote-cloud-home.mjs", import.meta.url)), "--version", version], { stdio: "inherit" });
}
console.log("[publish-desktop-feed] OK");

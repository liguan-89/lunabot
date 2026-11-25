// Publishes one release to the DEX Cloud file feed and keeps only the newest
// version there. Desktop assets go to downloads/desktop/ (served under
// /desktop/*); the Android channel APK replaces downloads/lunabot.apk and its
// update.json is rewritten from the APK bytes. Old LUNABOT-<version>-* files
// and every *.bak-* backup are removed, so the server never accumulates
// history the GitHub release already keeps.
//
//   node scripts/publish-desktop-feed.mjs [--assets-dir release-assets] \
//     [--apk path/to/app-dist.apk] [--notes "release notes"] [--dry-run] \
//     [--no-cloud-home] [--verify-only]
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
import { fileURLToPath, pathToFileURL } from "node:url";

const FEED_BASE = process.env.LUNABOT_FEED_BASE || "https://cloud.dexai.vip";
const SSH_HOST = process.env.LUNABOT_PUBLISH_HOST || "wholesale";
const DATA_DIR = process.env.LUNABOT_PUBLISH_DATA_DIR || "/opt/dex-cloud/data";
const DESKTOP_DIR = `${DATA_DIR}/downloads/desktop`;
const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;

const transport = await import(
  process.env.LUNABOT_FEED_TRANSPORT
    ? pathToFileURL(path.resolve(process.env.LUNABOT_FEED_TRANSPORT)).href
    : new URL("./publish-feed-transport.mjs", import.meta.url).href
);

function fail(message) {
  console.error(`[publish-desktop-feed] ${message}`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const verifyOnly = process.argv.includes("--verify-only");
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

const FEEDS = ["latest-linux.yml", "latest-mac.yml", "latest.yml"];
const STABLE_PAIRS = [
  ["LUNABOT.dmg", `LUNABOT-${version}-arm64.dmg`],
  ["LUNABOT-setup.exe", `LUNABOT-${version}-setup.exe`],
  ["LUNABOT-amd64.deb", `LUNABOT-${version}-amd64.deb`],
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
  return transport.ssh(SSH_HOST, command).trim();
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

// The binaries a latest*.yml promises, keyed by file name: `files:` entries
// plus the top-level `path:` shorthand (a duplicate of files[0]).
function ymlEntries(body) {
  const entries = new Map();
  let current;
  for (const line of body.split("\n")) {
    const named = line.match(/^\s+-\s+url:\s*(\S+)\s*$/) ?? line.match(/^path:\s*(\S+)\s*$/);
    if (named) {
      current = entries.get(named[1]) ?? {};
      entries.set(named[1], current);
      continue;
    }
    const sha = line.match(/^\s*sha512:\s*(\S+)\s*$/);
    if (sha && current) { current.sha512 = sha[1]; continue; }
    const size = line.match(/^\s*size:\s*(\d+)\s*$/);
    if (size && current) current.size = Number(size[1]);
  }
  return entries;
}

function localSha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function remoteSha512(remotePath) {
  try {
    return ssh(`openssl dgst -sha512 -binary "${remotePath}" | openssl base64 | tr -d '\\n'`);
  } catch {
    fail(`cannot hash ${remotePath} on ${SSH_HOST}`);
  }
}

// The staged binaries must already match the yml they ship with — a truncated
// assets dir would otherwise upload cleanly and fail client-side verification.
for (const feed of FEEDS) {
  for (const [name, meta] of ymlEntries(readFileSync(path.join(assetsDir, feed), "utf8"))) {
    const file = path.join(assetsDir, name);
    if (!existsSync(file)) fail(`missing release asset: ${name}`);
    if (localSha512(file) !== meta.sha512) {
      fail(`${name} sha512 does not match ${feed}: truncated or stale asset in ${assetsDir}`);
    }
  }
}

if (!verifyOnly) {
  for (const u of uploads) {
    transport.rsyncPut(SSH_HOST, u.local, u.remote);
  }
  for (const name of desktopDeletes) {
    ssh(`rm -f -- ${DESKTOP_DIR}/${name}`);
  }
  for (const item of channelPlan) {
    if (item.delete) {
      ssh(`rm -f -- ${item.remote}`);
    } else if (item.content) {
      transport.sshWrite(SSH_HOST, `cat > ${item.remote}`, item.content);
    } else {
      transport.rsyncPut(SSH_HOST, item.local, item.remote);
    }
  }
}

function fetchText(url) {
  try {
    return transport.fetchText(url);
  } catch {
    fail(`feed check failed: ${url}`);
  }
}
for (const feed of FEEDS) {
  const body = fetchText(`${FEED_BASE}/desktop/${feed}`);
  if (!body.includes(version)) fail(`${feed} on the feed does not mention ${version}`);
  for (const [name, meta] of ymlEntries(body)) {
    const remote = remoteSha512(`${DESKTOP_DIR}/${name}`);
    if (remote !== meta.sha512) {
      fail(`${name} on the feed does not match ${feed}: sha512 ${remote}, expected ${meta.sha512}`);
    }
  }
  console.log(`[publish-desktop-feed] ${feed} serves ${version} with matching binaries`);
}
for (const [stable, versioned] of STABLE_PAIRS) {
  try {
    ssh(`cmp -s "${DESKTOP_DIR}/${stable}" "${DESKTOP_DIR}/${versioned}"`);
  } catch {
    fail(`${stable} on the feed differs from ${versioned}`);
  }
}
console.log("[publish-desktop-feed] stable-name aliases match their versioned binaries");
if (apkPath) {
  const manifest = JSON.parse(fetchText(`${FEED_BASE}/update.json`));
  const [major, minor, patch] = version.split(".").map(Number);
  const versionCode = major * 10000 + minor * 100 + patch;
  if (manifest.versionCode !== versionCode) {
    fail(`update.json serves versionCode ${manifest.versionCode}, expected ${version}`);
  }
  const remoteApk = ssh(`openssl dgst -sha256 "${DOWNLOADS_DIR}/lunabot.apk"`).match(/[0-9a-f]{64}/i)?.[0];
  const localApk = createHash("sha256").update(readFileSync(path.resolve(apkPath))).digest("hex");
  if (remoteApk !== localApk) {
    fail(`channel APK sha256 ${remoteApk}, expected ${localApk}`);
  }
  try {
    ssh(`cmp -s "${DESKTOP_DIR}/${apkFeedName}" "${DOWNLOADS_DIR}/lunabot.apk"`);
  } catch {
    fail(`desktop/${apkFeedName} on the feed differs from downloads/lunabot.apk`);
  }
  const apkUrl = `${FEED_BASE}${manifest.apkUrl}`;
  let head;
  try {
    head = transport.fetchHead(apkUrl);
  } catch {
    fail(`channel APK does not download: ${apkUrl}`);
  }
  const served = Number(head.match(/content-length:\s*(\d+)/i)?.[1]);
  if (served !== manifest.size) fail(`channel APK serves ${served} bytes, manifest promises ${manifest.size}`);
  console.log(`[publish-desktop-feed] update.json serves ${version} (versionCode ${manifest.versionCode}, APK ${served} bytes)`);
}
console.log("[publish-desktop-feed] feed OK");

if (verifyOnly || process.argv.includes("--no-cloud-home")) {
  console.log(`[publish-desktop-feed] cloud-home promotion skipped${verifyOnly ? " (--verify-only)" : " (--no-cloud-home)"}`);
} else {
  execFileSync(process.execPath, [fileURLToPath(new URL("./promote-cloud-home.mjs", import.meta.url)), "--version", version], { stdio: "inherit" });
}
console.log("[publish-desktop-feed] OK");

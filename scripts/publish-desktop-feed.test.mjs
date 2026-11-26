import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VERSION = "2.1.9";
const SCRIPT = fileURLToPath(new URL("./publish-desktop-feed.mjs", import.meta.url));
const FAKE_TRANSPORT = fileURLToPath(new URL("./testing/publish-feed-fake-transport.mjs", import.meta.url));
const sha512b64 = (buf) => createHash("sha512").update(buf).digest("base64");
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

function feedYml(files) {
  const lines = [`version: ${VERSION}`, "files:"];
  for (const [name, buf] of files) {
    lines.push(`  - url: ${name}`, `    sha512: ${sha512b64(buf)}`, `    size: ${buf.length}`);
  }
  lines.push(`path: ${files[0][0]}`, `sha512: ${sha512b64(files[0][1])}`, "releaseDate: '2026-11-25T00:00:00.000Z'");
  return `${lines.join("\n")}\n`;
}

function writeAssets(dir) {
  const put = (name, buf) => writeFileSync(path.join(dir, name), buf);
  const deb = Buffer.from(`deb-bytes-${VERSION}`);
  const dmg = Buffer.from(`dmg-bytes-${VERSION}`);
  const zip = Buffer.from(`zip-bytes-${VERSION}`);
  const exe = Buffer.from(`exe-bytes-${VERSION}`);
  const apk = Buffer.from(`apk-bytes-${VERSION}`);
  put(`LUNABOT-${VERSION}-amd64.deb`, deb);
  put(`LUNABOT-${VERSION}-arm64.dmg`, dmg);
  put(`LUNABOT-${VERSION}-arm64.dmg.blockmap`, Buffer.from("dmg-map"));
  put(`LUNABOT-${VERSION}-arm64.zip`, zip);
  put(`LUNABOT-${VERSION}-arm64.zip.blockmap`, Buffer.from("zip-map"));
  put(`LUNABOT-${VERSION}-setup.exe`, exe);
  put(`LUNABOT-${VERSION}-setup.exe.blockmap`, Buffer.from("exe-map"));
  put(`LUNABOT-${VERSION}-android-arm64.apk`, apk);
  put("LUNABOT-amd64.deb", deb);
  put("LUNABOT-setup.exe", exe);
  put("LUNABOT.dmg", dmg);
  put("latest-linux.yml", Buffer.from(feedYml([[`LUNABOT-${VERSION}-amd64.deb`, deb]])));
  put("latest-mac.yml", Buffer.from(feedYml([[`LUNABOT-${VERSION}-arm64.zip`, zip], [`LUNABOT-${VERSION}-arm64.dmg`, dmg]])));
  put("latest.yml", Buffer.from(feedYml([[`LUNABOT-${VERSION}-setup.exe`, exe]])));
  put("SHA256SUMS-ubuntu-x64.txt", Buffer.from(`${sha256hex(deb)}  LUNABOT-${VERSION}-amd64.deb\n${sha256hex(deb)}  LUNABOT-amd64.deb\n`));
  return { apk: path.join(dir, `LUNABOT-${VERSION}-android-arm64.apk`) };
}

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "feed-test-"));
  const assets = path.join(root, "assets");
  const downloads = path.join(root, "data", "downloads");
  mkdirSync(path.join(downloads, "desktop"), { recursive: true });
  mkdirSync(assets, { recursive: true });
  // Forward slashes: remote paths are regex-parsed inside the fake transport.
  const data = `${root}/data`.replaceAll("\\", "/");
  return { root, assets, downloads, data };
}

// The fake transport stands in for ssh/rsync/curl against a local dir, so the
// script under test runs identically on every platform.
function runScript(workspace, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: {
      ...process.env,
      LUNABOT_FEED_TRANSPORT: FAKE_TRANSPORT,
      FAKE_ROOT: workspace.data,
      LUNABOT_PUBLISH_DATA_DIR: workspace.data,
      LUNABOT_PUBLISH_HOST: "fakehost",
      LUNABOT_FEED_BASE: "https://feed.test",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("publish-desktop-feed", () => {
  it("uploads the release set and verifies every served binary", () => {
    const ws = makeWorkspace();
    const { apk } = writeAssets(ws.assets);
    writeFileSync(path.join(ws.downloads, "dexbot.apk"), Buffer.from("legacy"));
    const result = runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--no-cloud-home"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("feed OK");
    const desktop = path.join(ws.downloads, "desktop");
    expect(readFileSync(path.join(desktop, `LUNABOT-${VERSION}-arm64.zip`))).toEqual(readFileSync(path.join(ws.assets, `LUNABOT-${VERSION}-arm64.zip`)));
    expect(readFileSync(path.join(desktop, "LUNABOT.dmg"))).toEqual(readFileSync(path.join(ws.assets, `LUNABOT-${VERSION}-arm64.dmg`)));
    expect(readFileSync(path.join(ws.downloads, "lunabot.apk"))).toEqual(readFileSync(apk));
    expect(JSON.parse(readFileSync(path.join(ws.downloads, "update.json"), "utf8")).versionCode).toBe(20109);
    expect(existsSync(path.join(ws.downloads, "dexbot.apk"))).toBe(false);
  });

  it("refuses to upload a truncated asset whose sha512 does not match the yml", () => {
    const ws = makeWorkspace();
    const { apk } = writeAssets(ws.assets);
    // gh release download truncation: the file is shorter than the yml promises.
    writeFileSync(path.join(ws.assets, `LUNABOT-${VERSION}-arm64.zip`), Buffer.from("zip-by"));

    const result = runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--no-cloud-home"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("truncated or stale asset");
    expect(existsSync(path.join(ws.downloads, "desktop", `LUNABOT-${VERSION}-arm64.zip`))).toBe(false);
  });

  it("verify-only catches a remote binary that no longer matches the yml", () => {
    const ws = makeWorkspace();
    const { apk } = writeAssets(ws.assets);
    expect(runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--no-cloud-home"]).status).toBe(0);
    writeFileSync(path.join(ws.downloads, "desktop", `LUNABOT-${VERSION}-setup.exe`), Buffer.from("corrupted"));

    const result = runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--verify-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`LUNABOT-${VERSION}-setup.exe on the feed does not match`);
  });

  it("verify-only catches a stale stable-name alias", () => {
    const ws = makeWorkspace();
    const { apk } = writeAssets(ws.assets);
    expect(runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--no-cloud-home"]).status).toBe(0);
    writeFileSync(path.join(ws.downloads, "desktop", "LUNABOT.dmg"), Buffer.from("older-build"));

    const result = runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--verify-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`LUNABOT.dmg on the feed differs`);
  });

  it("verify-only catches a channel APK that does not match its manifest", () => {
    const ws = makeWorkspace();
    const { apk } = writeAssets(ws.assets);
    expect(runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--no-cloud-home"]).status).toBe(0);
    writeFileSync(path.join(ws.downloads, "lunabot.apk"), Buffer.from("wrong-apk"));

    const result = runScript(ws, ["--assets-dir", ws.assets, "--apk", apk, "--verify-only"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("channel APK sha256");
  });
});

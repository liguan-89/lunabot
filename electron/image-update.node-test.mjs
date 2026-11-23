// The adhoc-signed macOS update path: check with electron-updater, then download the release's .dmg, verify it, open it.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createImageUpdateCoordinator, feedBaseUrl, imageFromFeed } from "./image-update.mjs";

const FEED = `provider: generic
url: https://cloud.dexai.vip/desktop
updaterCacheDirName: dexbot-updater
`;

function sha512(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

function harness(t, { dmg = "fixture DMG bytes", sha = null, files = null, status = 200, openError = "" } = {}) {
  const updater = new EventEmitter();
  const states = [];
  let version = "2.1.6";
  const requests = [];
  let opens = 0;
  const workspace = mkdtempSync(join(tmpdir(), "omb-image-update-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const bytes = Buffer.isBuffer(dmg) ? dmg : Buffer.from(dmg);
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", {
      version,
      files: files ?? [
        { url: `LUNABOT-${version}-arm64.zip`, sha512: "zip-digest", size: 10 },
        { url: `LUNABOT-${version}-arm64.dmg`, sha512: sha ?? sha512(bytes), size: bytes.length },
      ],
    });
  };
  const coordinator = createImageUpdateCoordinator(updater, (patch) => states.push(patch), {
    baseUrl: "https://cloud.dexai.vip/desktop",
    downloadDir: join(workspace, "pending-image"),
    openPath: async () => { opens += 1; return openError; },
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(bytes.length) : null) },
        arrayBuffer: async () => bytes,
      };
    },
    log: () => {},
  });
  const last = () => states.at(-1);
  const settle = async (promise) => { await promise; await new Promise((resolve) => setImmediate(resolve)); };
  return {
    updater, coordinator, states, last, requests, workspace, settle,
    setVersion: (value) => { version = value; },
    opens: () => opens,
    pending: () => join(workspace, "pending-image"),
    files: () => (existsSync(join(workspace, "pending-image")) ? readdirSync(join(workspace, "pending-image")) : []),
  };
}

test("the feed address comes from app-update.yml, and a missing file is not fatal", () => {
  assert.equal(feedBaseUrl({ resourcesPath: "/app/Contents/Resources", readFile: () => FEED }), "https://cloud.dexai.vip/desktop");
  assert.equal(feedBaseUrl({ resourcesPath: "/app/Contents/Resources", readFile: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(feedBaseUrl({ resourcesPath: "", readFile: () => FEED }), null);
  assert.equal(feedBaseUrl({ resourcesPath: "/app/Contents/Resources", readFile: () => "provider: generic\n" }), null);
});

test("the disk image is the feed's .dmg, resolved against the feed", () => {
  const info = { files: [{ url: "x.zip", sha512: "a" }, { url: "LUNABOT-2.1.6-arm64.dmg", sha512: "b", size: 5 }] };
  assert.deepEqual(imageFromFeed(info, "https://cloud.dexai.vip/desktop"), {
    url: "https://cloud.dexai.vip/desktop/LUNABOT-2.1.6-arm64.dmg",
    name: "LUNABOT-2.1.6-arm64.dmg",
    sha512: "b",
    size: 5,
  });
  assert.equal(imageFromFeed({ files: [{ url: "https://other.test/x.dmg" }] }, null).url, "https://other.test/x.dmg");
  assert.equal(imageFromFeed({ files: [{ url: "x.zip" }] }, "https://feed.test/d"), null);
  assert.equal(imageFromFeed({ files: [{ url: "x.dmg" }] }, null), null);
  assert.equal(imageFromFeed({}, "https://feed.test/d"), null);
});

test("checking downloads the image, verifies it and hands it to the person to open", async (t) => {
  const h = harness(t);
  await h.settle(h.coordinator.check());
  assert.deepEqual(h.requests, ["https://cloud.dexai.vip/desktop/LUNABOT-2.1.6-arm64.dmg"]);
  assert.equal(h.last().status, "downloaded");
  assert.equal(h.last().version, "2.1.6");
  assert.deepEqual(h.files(), ["LUNABOT-2.1.6-arm64.dmg"]);
  assert.equal(readFileSync(join(h.pending(), "LUNABOT-2.1.6-arm64.dmg"), "utf8"), "fixture DMG bytes");
  assert.equal(h.states.some((state) => state.status === "downloading" && state.percent === 100), true);

  await h.settle(h.coordinator.install());
  assert.equal(h.opens(), 1);
  assert.equal(h.last().status, "handed-off");
  assert.equal(h.last().messageKey, "native.update.imageOpened");
  // A second click has nothing left to open.
  await h.settle(h.coordinator.install());
  assert.equal(h.opens(), 1);
  assert.deepEqual(h.coordinator.installable(), null);
});

test("a digest that does not match the feed fails as an integrity error and leaves no file", async (t) => {
  const h = harness(t, { sha: sha512("some other release") });
  await h.settle(h.coordinator.check());
  assert.equal(h.last().status, "error");
  assert.equal(h.last().messageCode, "integrity");
  assert.equal(h.last().retryable, true);
  assert.deepEqual(h.files(), []);
  assert.equal(h.opens(), 0);
});

test("a cached image is trusted only while its digest still matches, and a wrong one is replaced", async (t) => {
  const h = harness(t);
  await h.settle(h.coordinator.check());
  const before = h.requests.length;
  // The same release checked again: the file on disk is already right, so nothing is downloaded.
  await h.settle(h.coordinator.check());
  assert.equal(h.requests.length, before);
  assert.equal(h.last().status, "downloaded");

  // The feed now offers different bytes under the same name: the stale file must not be reused.
  writeFileSync(join(h.pending(), "LUNABOT-2.1.6-arm64.dmg"), "tampered");
  await h.settle(h.coordinator.check());
  assert.equal(h.requests.length, before + 1);
  assert.equal(readFileSync(join(h.pending(), "LUNABOT-2.1.6-arm64.dmg"), "utf8"), "fixture DMG bytes");
});

test("a feed without a disk image says so instead of failing silently", async (t) => {
  const h = harness(t, { files: [{ url: "LUNABOT-2.1.6-arm64.zip", sha512: "a" }] });
  await h.settle(h.coordinator.check());
  assert.equal(h.last().status, "error");
  assert.equal(h.last().messageKey, "native.update.imageNoDmg");
  assert.equal(h.last().retryable, true);
});

test("a feed without a checksum refuses the download rather than trusting it", async (t) => {
  const h = harness(t, { files: [{ url: "LUNABOT-2.1.6-arm64.dmg", size: 5 }] });
  await h.settle(h.coordinator.check());
  assert.equal(h.last().status, "error");
  assert.equal(h.last().messageKey, "native.update.noChecksum");
  assert.equal(h.requests.length, 0);
});

test("an HTTP failure is classified the way the native updater classifies one", async (t) => {
  for (const [status, code] of [[404, "feed"], [500, "network"]]) {
    const h = harness(t, { status });
    await h.settle(h.coordinator.check());
    assert.equal(h.last().status, "error", String(status));
    assert.equal(h.last().messageCode, code, String(status));
    assert.deepEqual(h.files(), [], String(status));
  }
});

test("an image that cannot be opened stays the person's to retry", async (t) => {
  const h = harness(t, { openError: "no application opens disk images" });
  await h.settle(h.coordinator.check());
  await h.settle(h.coordinator.install());
  assert.equal(h.last().status, "error");
  assert.equal(h.last().messageKey, "native.update.imageOpenFailed");
  assert.equal(h.last().retryable, true);
  // The downloaded image is gone from the state, but checking again finds it cached and ready.
  await h.settle(h.coordinator.check());
  assert.equal(h.last().status, "downloaded");
});

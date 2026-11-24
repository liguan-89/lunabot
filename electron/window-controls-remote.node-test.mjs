import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const LOCAL = "http://127.0.0.1:48993";
const REMOTE = "https://remote.example.test";
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");

function loadPreload(origin) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(preloadSource, {
    process: { platform: "win32", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin },
    navigator: {},
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve(true); } },
    }),
  });
  return { bridge, invoked };
}

/** Values made in the vm's realm fail deepEqual's prototype check; a JSON round brings them here. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// The window's own frame is gone; a remote server's page on the last two releases still calls these, so they answer
// "off" and do nothing (bridge-contract.json).
test("a remote server's page keeps the windowControls and windowFrame keys, as stubs that never reach main", async () => {
  const remote = loadPreload(REMOTE);
  assert.deepEqual(Object.keys(remote.bridge.windowControls).sort(), ["close", "minimize", "onMaximizedChanged", "state", "toggleMaximize"]);
  assert.equal(await remote.bridge.windowControls.minimize(), false);
  assert.equal(await remote.bridge.windowControls.toggleMaximize(), false);
  assert.equal(await remote.bridge.windowControls.close(), false);
  assert.deepEqual(plain(await remote.bridge.windowControls.state()), { maximized: false });
  assert.equal(typeof remote.bridge.windowControls.onMaximizedChanged(), "function");
  assert.deepEqual(plain(await remote.bridge.windowFrame.state()), { on: false, restart: false });
  assert.deepEqual(plain(await remote.bridge.windowFrame.set(true)), { on: false, restart: false });
  assert.deepEqual(remote.invoked, [], "stubs never reach main's channels");
  assert.equal(remote.bridge.copyText, undefined, "local-only APIs stay off the remote bridge");
});

test("the local page keeps the same stubs", async () => {
  const local = loadPreload(LOCAL);
  assert.equal(typeof local.bridge.windowControls.minimize, "function");
  assert.equal(await local.bridge.windowControls.minimize(), false);
  assert.deepEqual(plain(await local.bridge.windowFrame.state()), { on: false, restart: false });
});

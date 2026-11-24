import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { createProvisioner } from "../src/provisioner.js";
import { reprovision } from "../src/reprovision.mjs";
import { openStore } from "../src/store.js";

const config = () => loadConfig({
  LUNABOT_CLOUD_DB: ":memory:",
  LUNABOT_CLOUD_ORIGIN: "https://cloud.dexai.vip",
  LUNABOT_CLOUD_DEV_CODES: "1",
});

/** Same docker double provisioner.test uses: every call recorded, `overrides`
 * replaces one call's answer (or throws, to stand in for a daemon rejection). */
function fakeDocker(overrides = {}) {
  const calls = [];
  const record = (name, answer) => async (...args) => {
    calls.push([name, ...args]);
    if (overrides[name]) return await overrides[name](...args);
    return answer;
  };
  return {
    calls,
    imageExists: record("imageExists", true),
    createVolume: record("createVolume", null),
    removeContainer: record("removeContainer", null),
    createCloudContainer: record("createCloudContainer", null),
    startContainer: record("startContainer", null),
    stopContainer: record("stopContainer", null),
    removeVolume: record("removeVolume", null),
    inspectContainer: record("inspectContainer", null),
  };
}

function insertCloud(store, id, status = "ready") {
  store.insertCloud({
    id,
    accountId: "acc-1",
    name: "Test",
    tier: "pro",
    status,
    origin: `https://${id}.cloud.dexai.vip`,
    role: "owner",
    hostname: `${id}.cloud.dexai.vip`,
    machineId: id,
    bootstrapSecret: "x".repeat(43),
    diskGb: 10,
    maxDiskGb: 20,
  });
  return id;
}

/** waitHealthy polls the container over HTTP; answer the way the home does. */
async function healthy(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"app":"lunabot"}' });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a running cloud is rebuilt on the local image and comes back ready", async () => {
  const store = openStore(":memory:");
  const docker = fakeDocker();
  const provisioner = createProvisioner({ config: config(), store, docker, log: () => {} });
  const id = insertCloud(store, "c-rebuild00001");
  const [result] = await healthy(() => reprovision({ store, docker, provisioner, ids: [id], engageMs: 50 }));
  assert.equal(result.status, "ready");
  // The old container goes first (explicit remove plus provision()'s own), then a fresh one on :local.
  const remove = docker.calls.findIndex(([name]) => name === "removeContainer");
  const create = docker.calls.findIndex(([name]) => name === "createCloudContainer");
  assert.ok(remove !== -1 && create !== -1 && remove < create);
  assert.equal(docker.calls[remove][1], `dexcloud-${id}`);
  assert.equal(docker.calls[create][1].image, "lunabot-cloud-home:local");
  assert.equal(store.cloud(id).status, "ready");
  store.close();
});

test("a rebuild that fails its health wait lands offline, not half-installed", async () => {
  const store = openStore(":memory:");
  const docker = fakeDocker({ createCloudContainer: async () => { throw new Error("docker says no"); } });
  const provisioner = createProvisioner({ config: config(), store, docker, log: () => {} });
  const id = insertCloud(store, "c-rebuild00002");
  const [result] = await reprovision({ store, docker, provisioner, ids: [id], engageMs: 50 });
  assert.equal(result.status, "offline");
  assert.equal(store.cloud(id).status, "offline");
  store.close();
});

test("missing and ended clouds are skipped, the rest still rebuild", async () => {
  const store = openStore(":memory:");
  const docker = fakeDocker();
  const provisioner = createProvisioner({ config: config(), store, docker, log: () => {} });
  const alive = insertCloud(store, "c-rebuild00003");
  insertCloud(store, "c-rebuild00004", "ended");
  const results = await healthy(() => reprovision({ store, docker, provisioner, ids: ["c-nope", "c-rebuild00004", alive], engageMs: 50 }));
  assert.deepEqual(results.map((r) => [r.id, r.status]), [
    ["c-nope", "missing"],
    ["c-rebuild00004", "missing"],
    [alive, "ready"],
  ]);
  assert.deepEqual(docker.calls.filter(([name]) => name === "removeContainer").map((call) => call[1]), [`dexcloud-${alive}`, `dexcloud-${alive}`]);
  store.close();
});

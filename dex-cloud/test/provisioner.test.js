import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { createProvisioner } from "../src/provisioner.js";
import { openStore } from "../src/store.js";

const config = () => loadConfig({
  LUNABOT_CLOUD_DB: ":memory:",
  LUNABOT_CLOUD_ORIGIN: "https://cloud.dexai.vip",
  LUNABOT_CLOUD_DEV_CODES: "1",
});

/** A docker double that records every call; an `overrides` entry replaces one
 * call's answer (or throws, to stand in for a daemon rejection). */
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

function insertCloud(store, id = "c-test0000001") {
  store.insertCloud({
    id,
    accountId: "acc-1",
    name: "Test",
    tier: "pro",
    status: "setting_up",
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

/** `start()` re-provisions in the background and returns at once: wait for the
 * row to leave the setup steps, whichever way it lands. */
async function settles(store, id) {
  for (let i = 0; i < 100; i += 1) {
    const cloud = store.cloud(id);
    if ((cloud.status === "ready" || cloud.status === "offline") && !cloud.setup_step) return cloud;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("provisioning never settled");
}

test("a missing cloud image refuses provisioning and names the image", async () => {
  const store = openStore(":memory:");
  const logs = [];
  const docker = fakeDocker({ imageExists: async () => false });
  const provisioner = createProvisioner({ config: config(), store, docker, log: (m) => logs.push(m) });
  const id = insertCloud(store);
  await provisioner.start(store.cloud(id));
  const row = await settles(store, id);
  assert.equal(row.status, "offline");
  // A failed provision leaves no container behind, so `awake` would be a lie
  // the row keeps forever — asleep is what makes a wake re-provision.
  assert.equal(row.power_state, "asleep");
  assert.ok(logs.some((m) => m.includes("cloud image missing: lunabot-cloud-home:local")));
  assert.ok(!docker.calls.some(([name]) => name === "createCloudContainer"), "no container is created");
});

test("a docker rejection reaches the log with the daemon's message and leaves the cloud asleep", async () => {
  const store = openStore(":memory:");
  const logs = [];
  const failure = Object.assign(new Error("docker POST /containers/create answered 404"), {
    body: { message: "No such image: ghost:gone" },
  });
  const docker = fakeDocker({ createCloudContainer: async () => { throw failure; } });
  const provisioner = createProvisioner({ config: config(), store, docker, log: (m) => logs.push(m) });
  const id = insertCloud(store);
  await provisioner.start(store.cloud(id));
  const row = await settles(store, id);
  assert.equal(row.status, "offline");
  assert.equal(row.power_state, "asleep");
  assert.ok(logs.some((m) => m.includes("No such image: ghost:gone")), "the daemon's own message is logged");
});

test("a wake re-provisions a cloud whose container never came up", async () => {
  const store = openStore(":memory:");
  const docker = fakeDocker();
  const provisioner = createProvisioner({ config: config(), store, docker, log: () => {} });
  const id = insertCloud(store);
  // waitHealthy polls the container over HTTP; answer the way the home does.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"app":"lunabot"}' });
  try {
    await provisioner.start(store.cloud(id));
    const row = await settles(store, id);
    assert.equal(row.status, "ready");
    assert.equal(row.origin, `https://${id}.cloud.dexai.vip`);
    assert.equal(row.power_state, "awake");
  } finally {
    globalThis.fetch = realFetch;
  }
  const created = docker.calls.find(([name]) => name === "createCloudContainer");
  assert.equal(created[1].name, `dexcloud-${id}`);
  assert.equal(created[1].image, "lunabot-cloud-home:local");
});

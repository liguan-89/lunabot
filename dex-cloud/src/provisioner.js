import { createHash, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import { randomBytesB64u } from "./crypto.js";

const HEALTH_INTERVAL_MS = 2_000;

const cloudId = () => `c-${randomBytes(6).toString("hex")}`;
const containerName = (id) => `dexcloud-${id}`;
const volumeName = (id) => `dexcloud-${id}-data`;

/** The edge routes by Host, so an internal call must present the Cloud's public name, not the container name. */
function cloudPost(cloud, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: containerName(cloud.id),
        port: 8080,
        path,
        method: "POST",
        headers: {
          ...headers,
          host: cloud.hostname,
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("cloud request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export function createProvisioner({ config, store, docker, log = console.log }) {
  async function waitHealthy(cloud) {
    const deadline = Date.now() + config.cloudProvisionTimeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${containerName(cloud.id)}:8080/api/health`, { signal: AbortSignal.timeout(4000) });
        const text = await response.text();
        if (response.ok && text.includes("openmausbot")) {
          store.updateCloud(cloud.id, { status: "ready", last_seen_at: Date.now() });
          return true;
        }
        last = `health ${response.status}`;
      } catch (error) {
        last = error?.message ?? "health failed";
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }
    log(`cloud ${cloud.id} did not become healthy: ${last}`);
    return false;
  }

  function environment(cloud) {
    return [
      "OMB_CLOUD_ROLE=home",
      `OMB_CLOUD_MACHINE_ID=${cloud.machine_id}`,
      `OMB_CLOUD_ADMIN_URL=${config.origin}`,
      `OMB_CLOUD_BOOTSTRAP_SECRET=${cloud.bootstrap_secret}`,
      `OMB_PUBLIC_URL=https://${cloud.hostname}`,
      "OMB_DATA_DIR=/data",
      "OMB_CLOUD_TRUSTED_PROXIES=private_ranges",
      "OMB_CLOUD_CLIENT_IP_HEADER=X-Forwarded-For",
      `OMB_SERVER_NAME=${cloud.name}`,
    ];
  }

  async function provision(cloud) {
    try {
      // The daemon does not pull on create (the CLI does): without this check a
      // missing image is a bare 404 that reads like a control plane bug.
      if (!(await docker.imageExists(config.cloudImage))) {
        throw Object.assign(new Error(`cloud image missing: ${config.cloudImage}`), { code: "cloud_image_missing" });
      }
      store.updateCloud(cloud.id, { setup_step: "storage", setup_progress: 0.4, power_state: "awake" });
      await docker.createVolume(volumeName(cloud.id));
      store.updateCloud(cloud.id, { setup_step: "starting", setup_progress: 0.65 });
      await docker.removeContainer(containerName(cloud.id));
      await docker.createCloudContainer({
        name: containerName(cloud.id),
        image: config.cloudImage,
        network: config.cloudNetwork,
        volume: volumeName(cloud.id),
        env: environment(cloud),
        memoryMb: config.cloudMemoryMb,
        nanoCpus: config.cloudNanoCpus,
      });
      await docker.startContainer(containerName(cloud.id));
      store.updateCloud(cloud.id, { setup_step: "checking", setup_progress: 0.9 });
      if (!(await waitHealthy(cloud))) {
        // No container came up, so `awake` would be a lie the row keeps forever
        // (nothing retries on its own): sleep it, and a wake re-provisions.
        store.updateCloud(cloud.id, { status: "offline", setup_step: null, setup_progress: null, power_state: "asleep" });
        return;
      }
      store.updateCloud(cloud.id, {
        status: "ready",
        origin: `https://${cloud.hostname}`,
        setup_step: null,
        setup_progress: null,
        last_seen_at: Date.now(),
      });
      log(`cloud ${cloud.id} is ready at https://${cloud.hostname}`);
    } catch (error) {
      // Docker errors carry the daemon's own message in `body` ("No such image:
      // …"); without it the log shows only the status code.
      log(`cloud ${cloud.id} provisioning failed: ${error?.body?.message ?? error?.message ?? error}`);
      store.updateCloud(cloud.id, { status: "offline", setup_step: null, setup_progress: null, power_state: "asleep" });
    }
  }

  return {
    cloudId,
    containerName,

    async create({ accountId, tier, name, color = null }) {
      const active = store.cloudsFor(accountId).filter((cloud) => !["ended"].includes(cloud.status));
      if (active.length >= config.cloudMaxPerAccount) throw Object.assign(new Error("cloud_cap"), { code: "cloud_cap" });
      const id = cloudId();
      const hostname = `${id}.${config.cloudHostSuffix}`;
      store.insertCloud({
        id,
        accountId,
        name,
        color,
        tier,
        status: "setting_up",
        origin: `https://${hostname}`,
        role: "owner",
        hostname,
        machineId: id,
        bootstrapSecret: randomBytesB64u(32),
        diskGb: config.cloudDiskGb,
        maxDiskGb: config.cloudMaxDiskGb,
      });
      store.updateCloud(id, { setup_step: "reserving", setup_progress: 0.15 });
      void provision(store.cloud(id));
      return store.cloud(id);
    },

    async start(cloud) {
      const container = await docker.inspectContainer(containerName(cloud.id));
      if (!container) {
        void provision(store.cloud(cloud.id));
        return store.cloud(cloud.id);
      }
      await docker.startContainer(containerName(cloud.id));
      store.updateCloud(cloud.id, { status: "setting_up", setup_step: "starting", setup_progress: 0.65, power_state: "waking" });
      if (await waitHealthy(cloud)) {
        store.updateCloud(cloud.id, { status: "ready", origin: `https://${cloud.hostname}`, setup_step: null, setup_progress: null, power_state: "awake" });
      } else {
        store.updateCloud(cloud.id, { status: "offline", setup_step: null, setup_progress: null });
      }
      return store.cloud(cloud.id);
    },

    async stop(cloud) {
      await docker.stopContainer(containerName(cloud.id));
      store.updateCloud(cloud.id, { status: "stopped", power_state: "asleep" });
      return store.cloud(cloud.id);
    },

    async remove(cloud) {
      await docker.stopContainer(containerName(cloud.id));
      await docker.removeContainer(containerName(cloud.id));
      await docker.removeVolume(volumeName(cloud.id));
      store.deleteCloud(cloud.id);
    },

    async pairing(cloud) {
      if (cloud.status !== "ready") {
        const started = await this.start(cloud);
        if (started.status !== "ready") throw Object.assign(new Error("not_running"), { code: "not_running" });
      }
      const body = Buffer.from(JSON.stringify({ label: "Luna Bot Cloud", ttlSeconds: 300 }), "utf8");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytesB64u(24);
      const bodyHash = createHash("sha256").update(body).digest("base64url");
      const signature = createHmac("sha256", cloud.bootstrap_secret)
        .update(`v1\n${timestamp}\n${nonce}\nPOST\n/api/cloud/pairing\n${bodyHash}`)
        .digest("base64url");
      const response = await cloudPost(cloud, "/api/cloud/pairing", body, {
        "x-omb-cloud-timestamp": timestamp,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${signature}`,
      });
      let answer = null;
      try {
        answer = JSON.parse(response.text);
      } catch {
        answer = null;
      }
      if (response.status < 200 || response.status >= 300 || typeof answer?.code !== "string" || !Number.isSafeInteger(answer?.expiresAt)) {
        throw Object.assign(new Error("pairing_refused"), { code: "pairing_refused", status: response.status });
      }
      return { origin: `https://${cloud.hostname}`, code: answer.code, expiresAt: answer.expiresAt };
    },
  };
}

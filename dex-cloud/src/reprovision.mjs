// Rebuilds the named clouds' containers on whatever lunabot-cloud-home:local
// points at now — the promote step runs this inside the control-plane
// container once the tag moves. The deployed image does not have to carry it:
// the caller streams it in and /app/src supplies the imports.
//
//   LUNABOT_REPROVISION_IDS=c-aaa,c-bbb \
//     docker exec -i -w /app/src dex-cloud-cloud-1 \
//       node --experimental-sqlite --input-type=module - < src/reprovision.mjs
//
//   # or, once the shipped image contains it:
//   LUNABOT_REPROVISION_IDS=c-aaa \
//     docker exec dex-cloud-cloud-1 node --experimental-sqlite /app/src/reprovision.mjs
import { loadConfig } from "./config.js";
import { createDocker } from "./docker.js";
import { createProvisioner } from "./provisioner.js";
import { openStore } from "./store.js";

const POLL_MS = 2_000;
// provision() writes setup_step before its first slow step, but that write
// trails start() by a docker call; a poll that trusts the row at once can read
// the stale "ready" and declare the rebuild over before it began. When the
// mark never comes (e.g. the image check fails first) the grace just costs
// its wait, and the row's terminal offline still reads correctly.
const ENGAGE_GRACE_MS = 10_000;

export async function reprovision({ store, docker, provisioner, ids, settleMs = 240_000, engageMs = ENGAGE_GRACE_MS, log = () => {} }) {
  const results = [];
  for (const id of ids) {
    const cloud = store.cloud(id);
    if (!cloud || cloud.status === "ended") {
      results.push({ id, status: "missing" });
      continue;
    }
    // start() provisions only when the container is gone — remove it first so
    // the wake path rebuilds on the image :local names now.
    await docker.removeContainer(provisioner.containerName(id));
    try {
      await provisioner.start(store.cloud(id));
    } catch (error) {
      results.push({ id, status: `error: ${error?.message ?? error}` });
      continue;
    }
    const deadline = Date.now() + settleMs;
    const engaged = Date.now() + engageMs;
    let row = store.cloud(id);
    while (Date.now() < engaged && !row.setup_step) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      row = store.cloud(id);
    }
    while (Date.now() < deadline && (row.setup_step || !["ready", "offline"].includes(row.status))) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      row = store.cloud(id);
    }
    const status = row.setup_step ? "timeout" : row.status;
    results.push({ id, status });
    log(`${id} → ${status}`);
  }
  return results;
}

const isCli = process.argv[1] === "-" || process.argv[1]?.endsWith("reprovision.mjs");
if (isCli) {
  const ids = (process.env.LUNABOT_REPROVISION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) {
    console.error("[reprovision] LUNABOT_REPROVISION_IDS names no clouds");
    process.exit(2);
  }
  const log = (message) => console.log(`[reprovision] ${message}`);
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const docker = createDocker(config.dockerSocket);
  const provisioner = createProvisioner({ config, store, docker, log });
  const results = await reprovision({ store, docker, provisioner, ids, log });
  for (const result of results) console.log(`${result.id} ${result.status}`);
  store.close();
  process.exit(results.every((result) => result.status === "ready") ? 0 : 1);
}

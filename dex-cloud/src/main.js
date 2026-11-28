import { createServer } from "node:http";

import { createApp } from "./server.js";
import { desktopPoolConfigured, loadConfig, loadRelaySeed } from "./config.js";
import { relaySigningKey } from "./crypto.js";
import { createDocker } from "./docker.js";
import { createEmailer } from "./email.js";
import { createDesktopPool, generateDesktopKey } from "./desktop-pool.js";
import { createProvisioner } from "./provisioner.js";
import { createRouter } from "./router.js";
import { openStore } from "./store.js";

const log = (message) => console.log(`[dex-cloud] ${message}`);

const config = loadConfig();
const store = openStore(config.dbPath);

let relayKey = null;
if (config.relaySeed) {
  relayKey = relaySigningKey(loadRelaySeed(config));
  log(`relay key ready (${config.relayKid}), node ${config.relayNodes.join(", ")}`);
} else {
  log("LUNABOT_CLOUD_RELAY_TOKEN_SEED is not set: relay tokens will be refused");
}

const emailer = createEmailer(config, log);
const docker = createDocker(config.dockerSocket);
const desktopPool = desktopPoolConfigured(config) ? createDesktopPool(config) : null;
const provisioner = createProvisioner({ config, store, docker, desktopPool, generateDesktopKey, log });
const app = createApp({ config, store, emailer, relayKey, provisioner, log });
const server = createServer(app);

docker.ensureNetwork(config.cloudNetwork)
  .then(() => docker.imageExists(config.cloudImage))
  .then((exists) => {
    if (!exists) log(`cloud image ${config.cloudImage} is missing: new clouds will stay offline until it is built`);
  })
  .catch((error) => log(`docker is unavailable: ${error?.message ?? error}`));

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} for ${config.origin}`);
});

const router = createRouter({ config, store, log });
router.listen(config.routerPort, "0.0.0.0", () => {
  log(`cloud router listening on http://0.0.0.0:${config.routerPort}`);
});
router.on("error", (error) => log(`cloud router failed: ${error?.message ?? error}`));

function shutdown(signal) {
  log(`${signal}: closing`);
  router.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

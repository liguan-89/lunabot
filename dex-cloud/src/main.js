import { createServer } from "node:http";

import { createApp } from "./server.js";
import { loadConfig, loadRelaySeed } from "./config.js";
import { relaySigningKey } from "./crypto.js";
import { createEmailer } from "./email.js";
import { openStore } from "./store.js";

const log = (message) => console.log(`[dex-cloud] ${message}`);

const config = loadConfig();
const store = openStore(config.dbPath);

let relayKey = null;
if (config.relaySeed) {
  relayKey = relaySigningKey(loadRelaySeed(config));
  log(`relay key ready (${config.relayKid}), node ${config.relayNodes.join(", ")}`);
} else {
  log("DEXCLOUD_RELAY_TOKEN_SEED is not set: relay tokens will be refused");
}

const emailer = createEmailer(config, log);
const app = createApp({ config, store, emailer, relayKey, log });
const server = createServer(app);

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} for ${config.origin}`);
});

function shutdown(signal) {
  log(`${signal}: closing`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

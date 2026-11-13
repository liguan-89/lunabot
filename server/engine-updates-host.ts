import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { AnyProviderDriver } from "./contracts.ts";
import { createEngineUpdater, enginePlans, type EngineUpdater } from "./engine-updates.ts";

/** The server's engine updater; `start()` it once the server is up. */
export function engineUpdatesFor(deps: {
  drivers: readonly AnyProviderDriver[];
  turnRunning(): boolean;
  configuredClis(): readonly string[];
  updated(): void;
}): EngineUpdater {
  return createEngineUpdater({
    plans: enginePlans(deps.drivers, {}),
    statePath: join(DATA_DIR, "providers", "engine-updates.json"),
    turnRunning: deps.turnRunning,
    configuredClis: deps.configuredClis,
    updated: deps.updated,
  });
}
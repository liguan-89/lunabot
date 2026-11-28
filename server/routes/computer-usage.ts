import * as cloudDesktop from "../cloud-desktop.ts";
import type { AppConfig } from "../config.ts";
import type { TeamComputers } from "../team-computers.ts";
import type { RemoteComputerProvider } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ComputerUsageRouteDeps {
  cfg: AppConfig;
  managedBoatOwners(): cloudDesktop.ManagedCloudOwner[];
  teamComputers: Pick<TeamComputers, "list">;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
}

/** GET /api/computers/usage → `{ cloudComputers: number | null, teamComputers: number }`: counts for the owner's daily
 * usage snapshot, never a name, an id or a state. `cloudComputers` is null while the VPS connection changes or the
 * provider cannot be read. */
export function createComputerUsageRoutes(deps: ComputerUsageRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || path !== "/api/computers/usage") return PASS;
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, { cloudComputers: await cloudComputers(deps), teamComputers: deps.teamComputers.list().length });
  };
}

async function cloudComputers({ cfg, managedBoatOwners, computerProviderConfigTransitions }: ComputerUsageRouteDeps): Promise<number | null> {
  if (!cloudDesktop.cloudConfigured(cfg)) return 0;
  if (computerProviderConfigTransitions.has("vps")) return null;
  const inventory = await cloudDesktop.listManagedCloudComputers(cfg, managedBoatOwners());
  return inventory.available ? inventory.instances.length : null;
}

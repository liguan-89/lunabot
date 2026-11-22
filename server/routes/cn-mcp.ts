// GET /api/mcp/cn-catalog[?refresh=1]   the Chinese services the official MCP Registry lists as directly connectable
import { cnMcpCatalog, type CnMcpCatalog } from "../cn-mcp-catalog.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CnMcpRouteDeps {
  /** Where the day-long cache lives. */
  dataDir: string;
  /** Overridable so a test answers without the network. */
  catalog?(refresh: boolean): Promise<CnMcpCatalog>;
}

export function createCnMcpRoutes(deps: CnMcpRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (method !== "GET" || path !== "/api/mcp/cn-catalog") return PASS;
    // `refresh=1` asks past the day-long cache; the page only sends it when the person asks for a refresh.
    const refresh = url.searchParams.get("refresh") === "1";
    const catalog = deps.catalog
      ? await deps.catalog(refresh)
      : await cnMcpCatalog({ dataDir: deps.dataDir, refresh });
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, catalog);
  };
}

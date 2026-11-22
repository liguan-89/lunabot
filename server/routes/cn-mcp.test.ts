import { describe, expect, it, vi } from "vitest";

import { PASS } from "./table.ts";
import { createCnMcpRoutes } from "./cn-mcp.ts";

const call = async (method: string, path: string, catalog?: (refresh: boolean) => Promise<unknown>) => {
  const answers: Array<[number, unknown]> = [];
  const headers: Array<[string, string]> = [];
  const out = await createCnMcpRoutes({
    dataDir: "/tmp/unused",
    ...(catalog ? { catalog: catalog as never } : {}),
  })({
    req: {} as never,
    res: { setHeader: (name: string, value: string) => { headers.push([name, value]); } } as never,
    url: new URL(`http://x${path}`),
    path: new URL(`http://x${path}`).pathname,
    method,
    auth: { kind: "loopback", scopes: ["admin", "client"] } as never,
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never,
    readBody: (async () => ({})) as never,
  });
  return { out, answers, headers };
};

describe("cn mcp routes", () => {
  it("leaves every other path and method to the next route", async () => {
    expect((await call("GET", "/api/mcp/servers")).out).toBe(PASS);
    expect((await call("GET", "/api/connectors/catalog")).out).toBe(PASS);
    expect((await call("POST", "/api/mcp/cn-catalog")).out).toBe(PASS);
  });

  it("answers the catalog, uncached by any proxy", async () => {
    const catalog = { servers: [{ name: "a/b", url: "https://a.test/mcp" }], fetchedAt: 7, fresh: true };
    const { answers, headers } = await call("GET", "/api/mcp/cn-catalog", async () => catalog);
    expect(answers).toEqual([[200, catalog]]);
    expect(headers).toEqual([["cache-control", "private, no-store"]]);
  });

  it("passes a refresh through to the catalog", async () => {
    const read = vi.fn(async () => ({ servers: [], fetchedAt: 1, fresh: true }));
    await call("GET", "/api/mcp/cn-catalog", read);
    expect(read).toHaveBeenLastCalledWith(false);
    await call("GET", "/api/mcp/cn-catalog?refresh=1", read);
    expect(read).toHaveBeenLastCalledWith(true);
  });

  it("treats any other refresh value as no refresh", async () => {
    const read = vi.fn(async () => ({ servers: [], fetchedAt: 1, fresh: true }));
    await call("GET", "/api/mcp/cn-catalog?refresh=true", read);
    expect(read).toHaveBeenLastCalledWith(false);
  });
});

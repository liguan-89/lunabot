import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cnMcpCatalog, type CnMcpCatalogDeps } from "./cn-mcp-catalog.ts";
import type { CnMcpRegistryServer } from "../shared/cn-mcp.ts";

const entry = (name: string, url: string): CnMcpRegistryServer => ({
  name, title: name, description: "", url, transport: "http", headerKeys: [],
});
/** A search that answers the same every time, typed so the catalog's own parameter types are checked. */
const answering = (servers: CnMcpRegistryServer[]): NonNullable<CnMcpCatalogDeps["search"]> => async () => servers;
const nothing: NonNullable<CnMcpCatalogDeps["search"]> = async () => null;

let dataDir: string;
const DAY = 24 * 60 * 60_000;

beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), "cn-mcp-")); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

describe("cnMcpCatalog", () => {
  it("searches every term and merges the answers", async () => {
    const asked: string[] = [];
    const catalog = await cnMcpCatalog({
      dataDir,
      terms: ["a", "b"],
      now: () => 1_000,
      search: async (term: string) => { asked.push(term); return term === "a" ? [entry("x/one", "https://one.test/mcp")] : [entry("y/two", "https://two.test/mcp")]; },
    });
    expect(asked).toEqual(["a", "b"]);
    expect(catalog.servers.map((server: CnMcpRegistryServer) => server.url)).toEqual(["https://one.test/mcp", "https://two.test/mcp"]);
    expect(catalog.fresh).toBe(true);
  });

  it("keeps one entry per address across terms", async () => {
    const same = entry("x/one", "https://one.test/mcp");
    const catalog = await cnMcpCatalog({ dataDir, terms: ["a", "b"], now: () => 1_000, search: answering([same]) });
    expect(catalog.servers).toHaveLength(1);
  });

  it("answers from the cache for a day, without searching again", async () => {
    const search = vi.fn(answering([entry("x/one", "https://one.test/mcp")]));
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search });
    expect(search).toHaveBeenCalledTimes(1);
    const second = await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000 + DAY - 1, search });
    expect(search).toHaveBeenCalledTimes(1);
    expect(second.servers).toHaveLength(1);
    expect(second.fetchedAt).toBe(1_000);
  });

  it("searches again once the cache is a day old", async () => {
    const search = vi.fn(answering([entry("x/one", "https://one.test/mcp")]));
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search });
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000 + DAY, search });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("searches even inside the day when the person asks for a refresh", async () => {
    const search = vi.fn(answering([entry("x/one", "https://one.test/mcp")]));
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search });
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, refresh: true, search });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good answer when the registry cannot be read at all", async () => {
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search: answering([entry("x/one", "https://one.test/mcp")]) });
    const offline = await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000 + 2 * DAY, search: nothing });
    expect(offline.fresh).toBe(false);
    expect(offline.servers.map((server: CnMcpRegistryServer) => server.url)).toEqual(["https://one.test/mcp"]);
    expect(offline.fetchedAt).toBe(1_000);
  });

  it("says it is empty and not fresh when there is nothing cached either", async () => {
    const catalog = await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search: nothing });
    expect(catalog).toEqual({ servers: [], fetchedAt: 1_000, fresh: false });
  });

  it("keeps a partial answer, and says it is not fresh", async () => {
    const catalog = await cnMcpCatalog({
      dataDir, terms: ["a", "b"], now: () => 1_000,
      search: async (term: string) => term === "a" ? [entry("x/one", "https://one.test/mcp")] : null,
    });
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.fresh).toBe(false);
  });

  it("writes the cache where the next run reads it", async () => {
    await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search: answering([entry("x/one", "https://one.test/mcp")]) });
    const stored = JSON.parse(await readFile(join(dataDir, "cn-mcp-catalog.json"), "utf8"));
    expect(stored.fetchedAt).toBe(1_000);
    expect(stored.servers[0].url).toBe("https://one.test/mcp");
  });

  it("ignores a cache file it cannot parse, and searches", async () => {
    await writeFile(join(dataDir, "cn-mcp-catalog.json"), "{ not json", "utf8");
    const search = vi.fn(answering([entry("x/one", "https://one.test/mcp")]));
    const catalog = await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_000, search });
    expect(search).toHaveBeenCalledTimes(1);
    expect(catalog.servers).toHaveLength(1);
  });

  it("ignores cache entries with no address", async () => {
    await writeFile(join(dataDir, "cn-mcp-catalog.json"), JSON.stringify({ fetchedAt: 1_000, servers: [{ name: "x/one" }, entry("y/two", "https://two.test/mcp")] }), "utf8");
    const catalog = await cnMcpCatalog({ dataDir, terms: ["a"], now: () => 1_001, search: answering([]) });
    expect(catalog.servers.map((server: CnMcpRegistryServer) => server.url)).toEqual(["https://two.test/mcp"]);
  });
});

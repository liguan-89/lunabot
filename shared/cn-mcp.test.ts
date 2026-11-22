import { describe, expect, it } from "vitest";

import { CN_MCP_SEARCH_TERMS, cnMcpServerName, cnRegistryServers } from "./cn-mcp";

const server = (overrides: Record<string, unknown> = {}) => ({
  server: {
    name: "cn.pianam.mcp/12306-train-mcp",
    description: "China Railway ticket availability",
    remotes: [{ type: "streamable-http", url: "https://mcp.pianam.cn/train-mcp/mcp" }],
    ...overrides,
  },
});

describe("cnRegistryServers", () => {
  it("reads a remote entry as a connectable service", () => {
    expect(cnRegistryServers({ servers: [server()] })).toEqual([{
      name: "cn.pianam.mcp/12306-train-mcp",
      title: "12306 Train Mcp",
      description: "China Railway ticket availability",
      url: "https://mcp.pianam.cn/train-mcp/mcp",
      transport: "http",
      headerKeys: [],
    }]);
  });

  it("prefers the entry's own title", () => {
    const [first] = cnRegistryServers({ servers: [server({ title: "China 12306 Train Tickets MCP" })] });
    expect(first!.title).toBe("China 12306 Train Tickets MCP");
  });

  it("keeps an sse address as sse and an http one as http", () => {
    const parsed = cnRegistryServers({ servers: [server({ remotes: [
      { type: "sse", url: "https://example.test/sse" },
      { type: "streamable-http", url: "https://example.test/mcp" },
    ] })] });
    expect(parsed.map((entry) => entry.transport)).toEqual(["sse", "http"]);
  });

  it("drops an entry with no remote address, since only remotes can be connected to", () => {
    expect(cnRegistryServers({ servers: [server({ remotes: [] })] })).toEqual([]);
    expect(cnRegistryServers({ servers: [{ server: { name: "x/y", packages: [{ registryType: "npm" }] } }] })).toEqual([]);
  });

  it("drops a remote whose address is not http or https", () => {
    expect(cnRegistryServers({ servers: [server({ remotes: [{ type: "streamable-http", url: "file:///etc/passwd" }] })] })).toEqual([]);
    expect(cnRegistryServers({ servers: [server({ remotes: [{ type: "streamable-http", url: "not a url" }] })] })).toEqual([]);
  });

  it("drops a remote whose transport this app cannot speak", () => {
    expect(cnRegistryServers({ servers: [server({ remotes: [{ type: "websocket", url: "https://example.test/ws" }] })] })).toEqual([]);
  });

  it("reads the header names a service asks for, in either shape the registry uses", () => {
    const [asObject] = cnRegistryServers({ servers: [server({ remotes: [
      { type: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
    ] })] });
    expect(asObject!.headerKeys).toEqual(["Authorization"]);
    const [asList] = cnRegistryServers({ servers: [server({ remotes: [
      { type: "streamable-http", url: "https://example.test/mcp", headers: [{ name: "X-Api-Key" }, "Authorization"] },
    ] })] });
    expect(asList!.headerKeys).toEqual(["X-Api-Key", "Authorization"]);
  });

  it("keeps one entry per address and skips a nameless one", () => {
    const parsed = cnRegistryServers({ servers: [
      server(),
      server(),
      server({ name: "" }),
    ] });
    expect(parsed).toHaveLength(1);
  });

  it("survives a payload that is not a registry answer", () => {
    expect(cnRegistryServers(null)).toEqual([]);
    expect(cnRegistryServers({})).toEqual([]);
    expect(cnRegistryServers({ servers: "no" })).toEqual([]);
    expect(cnRegistryServers({ servers: [null, 3, { server: null }] })).toEqual([]);
  });

  it("carries a repository when the entry publishes one", () => {
    const [first] = cnRegistryServers({ servers: [server({ repository: { url: "https://github.com/boy-373/12306-train-mcp" } })] });
    expect(first!.repository).toBe("https://github.com/boy-373/12306-train-mcp");
  });
});

describe("cnMcpServerName", () => {
  it("uses the readable tail of the registry name, prefixed when the tail starts with a digit", () => {
    expect(cnMcpServerName("cn.pianam.mcp/12306-train-mcp")).toBe("cn-12306-train-mcp");
    expect(cnMcpServerName("com.52choujiang/weibo-insights")).toBe("weibo-insights");
  });

  it("starts a name with a letter, since a server name must", () => {
    expect(cnMcpServerName("cn.pianam.mcp/12306-train-mcp")).toMatch(/^[a-z]/);
  });

  it("stays within a server name's 32 characters", () => {
    expect(cnMcpServerName(`x/${"a".repeat(60)}`).length).toBeLessThanOrEqual(32);
  });

  it("falls back to the whole name when its tail has nothing usable", () => {
    expect(cnMcpServerName("a/b")).toMatch(/^[a-z]/);
  });
});

describe("CN_MCP_SEARCH_TERMS", () => {
  it("asks about each Chinese service once", () => {
    expect(new Set(CN_MCP_SEARCH_TERMS).size).toBe(CN_MCP_SEARCH_TERMS.length);
    expect(CN_MCP_SEARCH_TERMS).toContain("12306");
    expect(CN_MCP_SEARCH_TERMS).toContain("weibo");
  });

  it("keeps the whole search a handful of requests", () => {
    expect(CN_MCP_SEARCH_TERMS.length).toBeLessThanOrEqual(30);
  });

  it("asks nothing shorter than three characters, which the registry refuses", () => {
    for (const term of CN_MCP_SEARCH_TERMS) expect(term.trim().length).toBeGreaterThanOrEqual(3);
  });
});

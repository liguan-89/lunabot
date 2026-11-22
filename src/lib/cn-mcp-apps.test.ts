import { describe, expect, it } from "vitest";

import { CN_MCP_APPS, cnMcpHeaders, cnMcpServerName, cnMcpUrl, isCnMcpAddress } from "./cn-mcp-apps";

const app = (id: string) => CN_MCP_APPS.find((entry) => entry.id === id)!;

describe("CN_MCP_APPS", () => {
  it("names every service once, with a valid server name", () => {
    const ids = CN_MCP_APPS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("gives every service its own address", () => {
    const urls = CN_MCP_APPS.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("connects every service over https", () => {
    for (const entry of CN_MCP_APPS) expect(entry.url).toMatch(/^https:\/\//);
  });

  it("says where each key comes from", () => {
    for (const entry of CN_MCP_APPS) if (entry.auth.kind !== "none") expect(entry.auth.keyUrl).toMatch(/^https:\/\//);
  });

  it("asks for a key by URL parameter only where the service documents one", () => {
    const query = CN_MCP_APPS.filter((entry) => entry.auth.kind === "query").map((entry) => entry.id);
    expect(query).toEqual(["cn-amap", "cn-didi", "cn-tencent-map", "cn-baidu-map"]);
  });

  it("leaves the two services that need no key without one", () => {
    expect(CN_MCP_APPS.filter((entry) => entry.auth.kind === "none").map((entry) => entry.id)).toEqual(["cn-12306", "cn-calendar"]);
  });

  it("puts every service in a group the page shows", () => {
    for (const entry of CN_MCP_APPS) expect(["life", "social", "work", "dev"]).toContain(entry.group);
  });
});

describe("cnMcpUrl", () => {
  it("adds the key parameter as a pointer, after an existing query", () => {
    expect(cnMcpUrl(app("cn-amap"), "vault:a")).toBe("https://mcp.amap.com/mcp?key=vault:a");
    expect(cnMcpUrl(app("cn-tencent-map"), "vault:b")).toBe("https://mcp.map.qq.com/sse?format=0&key=vault:b");
  });

  it("leaves the address alone without a key, and for a service that takes none", () => {
    expect(cnMcpUrl(app("cn-amap"))).toBe("https://mcp.amap.com/mcp");
    expect(cnMcpUrl(app("cn-12306"), "vault:a")).toBe("https://mcp.pianam.cn/train-mcp/mcp");
  });

  it("never puts a key in the address of a header service", () => {
    expect(cnMcpUrl(app("cn-weibo"), "vault:a")).toBe("https://mcp.52choujiang.com/weibo/mcp");
  });
});

describe("cnMcpHeaders", () => {
  it("sends a header service's key as a bearer pointer", () => {
    expect(cnMcpHeaders(app("cn-weibo"), "vault:a")).toEqual({ Authorization: "Bearer vault:a" });
  });

  it("sends nothing without a key, for a service that takes none, or one keyed by parameter", () => {
    expect(cnMcpHeaders(app("cn-weibo"))).toEqual({});
    expect(cnMcpHeaders(app("cn-12306"), "vault:a")).toEqual({});
    expect(cnMcpHeaders(app("cn-amap"), "vault:a")).toEqual({});
  });
});

describe("isCnMcpAddress", () => {
  it("recognises the service's own address, with or without a trailing slash and its key", () => {
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp" })).toBe(true);
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp/" })).toBe(true);
    expect(isCnMcpAddress(app("cn-amap"), { type: "http", url: "https://mcp.amap.com/mcp?key=vault:a" })).toBe(true);
  });

  it("recognises an sse service only over sse", () => {
    expect(isCnMcpAddress(app("cn-tencent-map"), { type: "sse", url: "https://mcp.map.qq.com/sse?format=0&key=vault:a" })).toBe(true);
    expect(isCnMcpAddress(app("cn-tencent-map"), { type: "http", url: "https://mcp.map.qq.com/sse?format=0" })).toBe(false);
  });

  it("refuses a look-alike host, a different path, or another service's key parameter", () => {
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://evil.test/train-mcp/mcp" })).toBe(false);
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://mcp.pianam.cn/other/mcp" })).toBe(false);
    expect(isCnMcpAddress(app("cn-amap"), { type: "http", url: "https://mcp.amap.com/mcp?ak=vault:a" })).toBe(false);
  });

  it("refuses an address carrying anything else, or a user and password", () => {
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://mcp.pianam.cn/train-mcp/mcp?token=abc" })).toBe(false);
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "https://user:pw@mcp.pianam.cn/train-mcp/mcp" })).toBe(false);
  });

  it("refuses a stdio server, and an address that is not a URL", () => {
    expect(isCnMcpAddress(app("cn-12306"), { url: undefined })).toBe(false);
    expect(isCnMcpAddress(app("cn-12306"), { type: "http", url: "not a url" })).toBe(false);
  });
});

describe("cnMcpServerName", () => {
  it("uses the service's id, then counts up past names already taken", () => {
    expect(cnMcpServerName(app("cn-amap"), [])).toBe("cn-amap");
    expect(cnMcpServerName(app("cn-amap"), [{ name: "cn-amap" }])).toBe("cn-amap-2");
    expect(cnMcpServerName(app("cn-amap"), [{ name: "cn-amap" }, { name: "cn-amap-2" }])).toBe("cn-amap-3");
  });
});

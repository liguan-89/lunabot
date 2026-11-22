// Chinese MCP services, found through the official MCP Registry (registry.modelcontextprotocol.io). The Registry is a
// public standard endpoint: no key, no account, no expiring address. Its full catalog is far too large to page through
// (over 40,000 entries, ten minutes at 100 a page), so the page searches it by keyword instead.
//
// Nothing here calls the network: these are the words to search with and the shape a result takes.

/** What to ask the Registry for. Each is one search request; the page runs them together. */
export const CN_MCP_SEARCH_TERMS: readonly string[] = [
  "12306", "weibo", "zhihu", "bilibili", "douyin", "xiaohongshu", "wechat", "weixin", "feishu", "lark",
  "dingtalk", "yuque", "gitee", "amap", "gaode", "baidu", "tencent", "alipay", "taobao", "jd", "qq", "china",
];

/** A Registry entry that can be connected to directly: a remote address over streamable HTTP or SSE. */
export interface CnMcpRegistryServer {
  /** The Registry's own name, `cn.pianam.mcp/12306-train-mcp`. */
  name: string;
  /** Its title when it publishes one, else the name's tail. */
  title: string;
  description: string;
  /** The address to connect to. */
  url: string;
  transport: "http" | "sse";
  /** Header names it asks for, when it publishes any: a service that wants a key says so here. */
  headerKeys: string[];
  /** Its source repository, when it publishes one. */
  repository?: string;
}

const REMOTE_TYPES: Readonly<Record<string, "http" | "sse">> = {
  "streamable-http": "http",
  "streamablehttp": "http",
  "http": "http",
  "sse": "sse",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The address a remote entry names, or "" when it is not one this app can connect to. */
function remoteAddress(remote: unknown): { url: string; transport: "http" | "sse" } | null {
  if (!remote || typeof remote !== "object") return null;
  const entry = remote as { type?: unknown; url?: unknown };
  const transport = REMOTE_TYPES[text(entry.type).toLowerCase()];
  const url = text(entry.url);
  if (!transport || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { url, transport };
}

/** The header names a remote entry asks for, so a service needing a key is known before anyone tries it. */
function headerKeysOf(remote: unknown): string[] {
  if (!remote || typeof remote !== "object") return [];
  const headers = (remote as { headers?: unknown }).headers;
  const names: string[] = [];
  const add = (name: unknown) => {
    const clean = text(name);
    if (clean && !names.some((seen) => seen.toLowerCase() === clean.toLowerCase())) names.push(clean);
  };
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (typeof header === "string") add(header);
      else if (header && typeof header === "object") add((header as { name?: unknown }).name);
    }
  } else if (headers && typeof headers === "object") {
    for (const name of Object.keys(headers)) add(name);
  }
  return names;
}

/** The name's tail, for a title: `cn.pianam.mcp/12306-train-mcp` reads `12306 train mcp` when it publishes no title. */
function titleFromName(name: string): string {
  const tail = name.slice(name.lastIndexOf("/") + 1);
  return tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A Registry answer as connectable services: remotes only, one entry per address, in the order the Registry gave them. */
export function cnRegistryServers(payload: unknown): CnMcpRegistryServer[] {
  const items = (payload as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(items)) return [];
  const out: CnMcpRegistryServer[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const server = (item as { server?: unknown } | null)?.server;
    if (!server || typeof server !== "object") continue;
    const entry = server as {
      name?: unknown; title?: unknown; description?: unknown; repository?: unknown; remotes?: unknown;
    };
    const name = text(entry.name);
    const remotes = Array.isArray(entry.remotes) ? entry.remotes : [];
    for (const remote of remotes) {
      const address = remoteAddress(remote);
      if (!address) continue;
      const key = `${name}\u0000${address.url}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const repository = (entry.repository as { url?: unknown } | undefined)?.url;
      out.push({
        name,
        title: text(entry.title) || titleFromName(name),
        description: text(entry.description),
        url: address.url,
        transport: address.transport,
        headerKeys: headerKeysOf(remote),
        ...(text(repository) ? { repository: text(repository) } : {}),
      });
    }
  }
  return out;
}

/** A server name for a Registry entry: a valid name (`^[a-z][a-z0-9_-]{0,31}$`), stable for the same entry.
 * The Registry's names are namespaced (`cn.pianam.mcp/12306-train-mcp`); the last part is the readable one, and the
 * namespace goes in front only when two entries would otherwise collide. */
export function cnMcpServerName(registryName: string): string {
  const tail = slug(registryName.slice(registryName.lastIndexOf("/") + 1));
  if (tail) return tail.slice(0, 32).replace(/-+$/, "");
  return slug(registryName).slice(0, 32).replace(/-+$/, "");
}

function slug(raw: string): string {
  const slugged = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(slugged) ? slugged : slugged ? `cn-${slugged}` : "";
}

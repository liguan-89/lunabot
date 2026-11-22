// The Chinese services behind the Apps page's 国内 filter, read from the official MCP Registry.
//
// The Registry is public and needs no key, but its catalog is far too large to walk (over 40,000 entries, ten minutes
// at a hundred a page), so this searches it by keyword instead: one request per term, run together, each answer cached
// for a day on disk. A search that fails keeps whatever the last good answer held, so the page works offline.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CN_MCP_SEARCH_TERMS, cnRegistryServers, type CnMcpRegistryServer } from "../shared/cn-mcp.ts";

const REGISTRY = process.env.OMB_MCP_REGISTRY_API ?? "https://registry.modelcontextprotocol.io/v0";
const CACHE_FILE = "cn-mcp-catalog.json";
/** A day: the Registry changes slowly, and every page visit would otherwise be 20 requests. */
const CACHE_TTL_MS = 24 * 60 * 60_000;
const SEARCH_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 8_000;

export interface CnMcpCatalog {
  servers: CnMcpRegistryServer[];
  /** When this answer was fetched, so the page can say how fresh it is. */
  fetchedAt: number;
  /** False when the Registry could not be read and this is the last good answer, or nothing. */
  fresh: boolean;
}

interface StoredCatalog {
  fetchedAt: number;
  servers: CnMcpRegistryServer[];
}

const cachePath = (dataDir: string) => join(dataDir, CACHE_FILE);

async function readCache(dataDir: string): Promise<StoredCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(dataDir), "utf8")) as Partial<StoredCatalog>;
    if (!Array.isArray(parsed.servers) || typeof parsed.fetchedAt !== "number") return null;
    return { fetchedAt: parsed.fetchedAt, servers: parsed.servers.filter((server): server is CnMcpRegistryServer => Boolean(server?.url && server?.name)) };
  } catch {
    return null;
  }
}

async function writeCache(dataDir: string, stored: StoredCatalog): Promise<void> {
  try {
    await writeFile(cachePath(dataDir), JSON.stringify(stored), "utf8");
  } catch {
    // A cache that cannot be written costs one search, not the page.
  }
}

/** One search term's answer: its connectable services, or null when the Registry could not be read. */
async function searchTerm(term: string, signal: AbortSignal): Promise<CnMcpRegistryServer[] | null> {
  const url = `${REGISTRY}/servers?search=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) return null;
    return cnRegistryServers(await response.json());
  } catch {
    return null;
  }
}

/** Every service the terms find, one entry per address, most-titled first within a term's order. */
function merge(answers: readonly (readonly CnMcpRegistryServer[])[]): CnMcpRegistryServer[] {
  const out: CnMcpRegistryServer[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    for (const server of answer) {
      const key = `${server.name}\u0000${server.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(server);
    }
  }
  return out;
}

export interface CnMcpCatalogDeps {
  dataDir: string;
  /** Overridable so a test can answer without the network. */
  search?(term: string, signal: AbortSignal): Promise<CnMcpRegistryServer[] | null>;
  terms?: readonly string[];
  now?(): number;
  /** The person asked for a refresh: search even when the cache is still fresh. */
  refresh?: boolean;
}

/** The catalog, from the cache when it is fresh, else from the Registry; a failed search keeps the last good answer. */
export async function cnMcpCatalog(deps: CnMcpCatalogDeps, signal = new AbortController().signal): Promise<CnMcpCatalog> {
  const now = deps.now?.() ?? Date.now();
  const cached = await readCache(deps.dataDir);
  if (!deps.refresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { servers: cached.servers, fetchedAt: cached.fetchedAt, fresh: true };
  }
  const terms = deps.terms ?? CN_MCP_SEARCH_TERMS;
  const search = deps.search ?? searchTerm;
  const answers = await Promise.all(terms.map((term) => search(term, signal)));
  const found = answers.filter((answer): answer is CnMcpRegistryServer[] => answer !== null);
  // Every term failing is the Registry being unreachable, not an empty catalog: keep what we had.
  if (found.length === 0) {
    return cached
      ? { servers: cached.servers, fetchedAt: cached.fetchedAt, fresh: false }
      : { servers: [], fetchedAt: now, fresh: false };
  }
  const servers = merge(found);
  // A partial answer is still better than the old one, but it is not complete: the cache keeps it and the page says how
  // fresh it is. A term that failed simply contributes nothing.
  const stored = { fetchedAt: now, servers };
  await writeCache(deps.dataDir, stored);
  return { servers, fetchedAt: now, fresh: found.length === terms.length };
}

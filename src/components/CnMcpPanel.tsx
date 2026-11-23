// The Apps page's 国内 filter: Chinese services that answer from mainland China, each on its own MCP server.
//
// Two sources. The cards above are services whose address and key handling were checked by hand, so they connect in one
// press. The list below them is the official MCP Registry searched by keyword, which is how services nobody has vetted
// yet still show up. Either way a connection becomes an ordinary MCP server, so bot access, tool lists, health checks
// and the Connected count all come from the machinery that already exists.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import { CN_MCP_APPS, cnMcpHeaders, cnMcpServerName, cnMcpUrl, isCnMcpAddress, type CnMcpApp, type CnMcpAuth } from "@/lib/cn-mcp-apps";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { updateMcpServers } from "@/lib/mcp-servers";
import { api, useStore } from "@/state/store";
import { openBotSettings } from "./bot-panel/panel-link";
import type { LocaleKey } from "@/locales";
import { isRemoteMcpListing, type McpServerListing } from "./mcp-draft";
import type { CnMcpRegistryServer } from "../../shared/cn-mcp";
import { cnMcpServerName as registryServerName } from "../../shared/cn-mcp";

interface CnCatalog {
  servers: CnMcpRegistryServer[];
  fetchedAt: number;
  fresh: boolean;
}

const GROUPS = ["life", "social", "work", "dev"] as const;
const PILL = "inline-flex h-7 shrink-0 items-center justify-center gap-2 rounded-full border border-hairline/45 px-3 text-[13px] font-medium leading-5 transition-colors";

const listed = (result: { servers?: McpServerListing[] } | undefined): McpServerListing[] => result?.servers ?? [];

/** `name`, then `name-2`, `name-3`…: never a name already taken. */
function freeName(name: string, servers: readonly McpServerListing[]): string {
  const taken = new Set(servers.map((server) => server.name));
  if (!taken.has(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name.slice(0, 30)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Whether this app's server is on and holds its key (or needs none). */
function appConnected(app: CnMcpApp, servers: readonly McpServerListing[]): boolean {
  const server = servers.find((entry) => isRemoteMcpListing(entry) && isCnMcpAddress(app, entry));
  if (!server || !server.enabled || !isRemoteMcpListing(server)) return false;
  const auth = app.auth;
  if (auth.kind === "none") return true;
  if (auth.kind === "query") {
    try { return Boolean(server.url && new URL(server.url).searchParams.get(auth.param)); } catch { return false; }
  }
  return server.headerKeys.some((name) => name.toLowerCase() === auth.header.toLowerCase());
}

export function CnMcpPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const { state, dispatch } = useStore();
  const [servers, setServers] = useState<McpServerListing[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CnCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ life: true, social: true, work: false, dev: false });
  const mounted = useRef(true);

  const loadServers = useCallback(() => api("/api/mcp/servers").then((result) => {
    if (!mounted.current) return;
    setServers(listed(result));
    updateMcpServers(listed(result));
  }).catch(() => {}), []);

  const loadCatalog = useCallback((refresh: boolean) => {
    setCatalogLoading(true);
    return api(`/api/mcp/cn-catalog${refresh ? "?refresh=1" : ""}`)
      .then((result) => { if (mounted.current) setCatalog(result as CnCatalog); })
      .catch(() => {})
      .finally(() => { if (mounted.current) setCatalogLoading(false); });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadServers();
    void loadCatalog(false);
    return () => { mounted.current = false; };
  }, [loadServers, loadCatalog, refreshKey]);

  /** Adds the app's server with its key kept in the Vault, then turns it on once it answers. */
  const connect = async (app: CnMcpApp) => {
    const key = keys[app.id]?.trim();
    if (app.auth.kind !== "none" && !key) { setError(t("cnMcp.keyRequired")); return; }
    setBusy(app.id);
    setError(null);
    try {
      const name = cnMcpServerName(app, servers);
      let pointer: string | undefined;
      const vaultKeys: string[] = [];
      if (app.auth.kind !== "none" && key) {
        const saved = await api("/api/vault/secrets", { method: "POST", body: JSON.stringify({ name: `${app.label} key`, value: key }) });
        pointer = `vault:${saved.secret.id}`;
        vaultKeys.push(saved.secret.id);
      }
      const entry = {
        type: "transport" in app ? app.transport : "http",
        url: cnMcpUrl(app, pointer),
        ...(Object.keys(cnMcpHeaders(app, pointer)).length ? { headers: cnMcpHeaders(app, pointer) } : {}),
        enabled: false,
      };
      const saved = await api("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ name, ...entry, ...(vaultKeys.length ? { vaultKeys } : {}) }),
      });
      if (!mounted.current) return;
      setServers(listed(saved));
      updateMcpServers(listed(saved));
      const tested = await api(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST" });
      if (!mounted.current) return;
      if (tested && tested.ok === false) {
        setError(t("cnMcp.keyRefused", { service: app.label }));
        return;
      }
      const on = await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
      if (!mounted.current) return;
      setServers(listed(on));
      updateMcpServers(listed(on));
      setKeys((current) => ({ ...current, [app.id]: "" }));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("cnMcp.connectFailed", { service: app.label }));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /** Adds a Registry entry as an ordinary server, off until the person turns it on. */
  const addRegistryServer = async (server: CnMcpRegistryServer) => {
    setBusy(server.url);
    setError(null);
    try {
      const name = freeName(registryServerName(server.name), servers);
      const saved = await api("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify({ name, type: server.transport, url: server.url, enabled: false }),
      });
      if (!mounted.current) return;
      setServers(listed(saved));
      updateMcpServers(listed(saved));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const disconnect = async (app: CnMcpApp) => {
    const server = servers.find((entry) => isRemoteMcpListing(entry) && isCnMcpAddress(app, entry));
    if (!server) return;
    setBusy(app.id);
    setError(null);
    try {
      const next = await api(`/api/mcp/servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
      if (!mounted.current) return;
      setServers(listed(next));
      updateMcpServers(listed(next));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /** Registry entries already added, or already a card above, by address: neither is offered twice. */
  const addedUrls = new Set(servers.filter((server) => isRemoteMcpListing(server)).map((server) => server.url));
  const cardUrls = new Set(CN_MCP_APPS.map((app) => new URL(app.url)));
  const sameAddress = (server: CnMcpRegistryServer) => {
    let address: URL;
    try { address = new URL(server.url); } catch { return false; }
    for (const own of cardUrls) {
      if (address.origin === own.origin && address.pathname.replace(/\/+$/, "") === own.pathname.replace(/\/+$/, "")) return true;
    }
    return false;
  };
  const registry = (catalog?.servers ?? []).filter((server) => !addedUrls.has(server.url) && !sameAddress(server));

  return (
    <div className="flex flex-col gap-7">
      <p className="text-[13px] leading-5 text-ink-secondary">{t("cnMcp.subtitle")}</p>
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}

      {GROUPS.map((group) => {
        const apps = CN_MCP_APPS.filter((app) => app.group === group);
        if (!apps.length) return null;
        const open = openGroups[group] ?? false;
        return (
          <section key={group} data-cn-group={group} aria-labelledby={`cn-group-${group}`}>
            <button
              type="button"
              onClick={() => setOpenGroups((current) => ({ ...current, [group]: !open }))}
              aria-expanded={open}
              className="mb-1.5 flex min-h-7 w-full items-center justify-between gap-3 rounded-full px-2 text-start"
            >
              <h3 id={`cn-group-${group}`} className="min-w-0 truncate text-[14px] font-semibold leading-5 text-ink">
                {t(`cnMcp.group.${group}` as LocaleKey)}
                <span className="ms-2 text-[12px] font-normal text-ink-secondary">{apps.length}</span>
              </h3>
              <ChevronDown size={15} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
            </button>
            {open && (
              <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2">
                {apps.map((app) => renderApp(app))}
              </div>
            )}
          </section>
        );
      })}

      <section data-cn-registry aria-labelledby="cn-registry-title">
        <div className="mb-1.5 flex min-h-7 items-center justify-between gap-3 px-2">
          <h3 id="cn-registry-title" className="min-w-0 truncate text-[14px] font-semibold leading-5 text-ink">
            {t("cnMcp.registry.title")}
            {catalog && <span className="ms-2 text-[12px] font-normal text-ink-secondary">{t("cnMcp.registry.fetched", { count: String(registry.length) })}</span>}
          </h3>
          <button
            type="button"
            disabled={catalogLoading}
            onClick={() => void loadCatalog(true)}
            className={cn(PILL, "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-50")}
          >
            <RefreshCw size={13} aria-hidden="true" className={cn(catalogLoading && "animate-spin")} />
            {t("cnMcp.registry.refresh")}
          </button>
        </div>
        <p className="mb-2 px-2 text-[12px] leading-relaxed text-ink-tertiary">{t("cnMcp.registry.subtitle")}</p>
        {catalog && !catalog.fresh && (
          <p role="status" className="mb-2 rounded-xl bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("cnMcp.registry.stale")}</p>
        )}
        {catalogLoading && !catalog && (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {t("cnMcp.connecting")}
          </div>
        )}
        {catalog && registry.length === 0 && <p className="px-2 py-6 text-[13px] text-ink-secondary">{t("cnMcp.registry.empty")}</p>}
        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2">
          {registry.map((server) => (
            <div key={`${server.name}${server.url}`} data-cn-registry-tile={server.name} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-raised text-[13px] font-semibold text-ink-secondary">
                  {server.title.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold leading-5 text-ink">{server.title}</div>
                  <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={server.description}>{server.description || server.url}</p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void addRegistryServer(server)}
                  className={cn(PILL, "min-w-[64px] bg-control/80 text-ink hover:border-hairline/65 hover:bg-raised-hover disabled:opacity-55")}
                >
                  {busy === server.url ? <Loader2 size={14} className="animate-spin" /> : t("cnMcp.registry.add")}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 px-2 text-[12px] leading-relaxed text-ink-tertiary">{t("cnMcp.moreHint")}</p>
      </section>
    </div>
  );

  function renderApp(app: CnMcpApp) {
    const connected = appConnected(app, servers);
    const mine = busy === app.id;
    const auth: CnMcpAuth = app.auth;
    const keyUrl = auth.kind === "none" ? "" : auth.keyUrl;
    return (
      <div key={app.id} data-cn-tile={app.id} className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-raised text-ink-secondary">
            {"glyph" in app.icon ? <app.icon.glyph size={19} aria-hidden="true" /> : <img src={app.icon.image} alt="" className="size-full rounded-[8px] object-contain" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold leading-5 text-ink">{app.label}</span>
              {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("cnMcp.connected")} />}
              {auth.kind === "none" && <span className="shrink-0 rounded-full bg-control/70 px-2 text-[11px] leading-4 text-ink-secondary">{t("cnMcp.noKey")}</span>}
            </div>
            <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={t(app.description)}>{t(app.description)}</p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void (connected ? disconnect(app) : connect(app))}
            className={cn(PILL, "min-w-[64px] bg-control/80 text-ink hover:border-hairline/65 hover:bg-raised-hover disabled:opacity-55")}
          >
            {mine ? <Loader2 size={14} className="animate-spin" /> : t(connected ? "cnMcp.disconnect" : "cnMcp.connect")}
          </button>
        </div>
        <div className="ps-[52px]">
          {auth.kind !== "none" && !connected && (
            <div className="mt-2 flex flex-col items-start gap-2">
              <input
                type="password"
                value={keys[app.id] ?? ""}
                disabled={busy !== null}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("cnMcp.keyLabel", { service: app.label })}
                placeholder={t("cnMcp.keyPlaceholder", { service: app.label })}
                onChange={(event) => { const value = event.target.value; setKeys((current) => ({ ...current, [app.id]: value })); }}
                onKeyDown={(event) => { if (event.key === "Enter") void connect(app); }}
                className="h-8 w-full min-w-0 rounded-lg border border-hairline/45 bg-inset/80 px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:bg-menu focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => void openExternalLink(keyUrl).catch(() => {})}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline"
              >
                {t("cnMcp.getKey", { service: app.label })}
                <ExternalLink size={11} aria-hidden="true" />
              </button>
            </div>
          )}
          <details className="mt-1 text-[12px] text-ink-secondary">
            <summary className="cursor-pointer">{t("cnMcp.access")}</summary>
            <p className="mt-2 leading-relaxed">{t(app.notice)}</p>
            <p className="mt-2 leading-relaxed">{t("cnMcp.accessHint")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(state.bots ?? []).filter((bot) => !bot.hidden).map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => { dispatch({ type: "togglePlugins", open: false }); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }}
                  className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover"
                >
                  {t("cnMcp.botSettings", { name: bot.name })}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
    );
  }
}

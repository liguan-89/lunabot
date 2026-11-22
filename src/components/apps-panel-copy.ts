// The Apps panel's own wording and card rules, kept out of the panel so the panel stays inside its line budget.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { HostedApp, HostedConnections } from "@/lib/hosted-mcp-apps";
import type { AppsFilter } from "./apps-filter";

/** Whether a hosted app's card shows: it matches the search, and the filter is All, or Connected and it isn't known to be
 * disconnected (unknown while its servers load). */
export function hostedShown(app: HostedApp, search: string, filter: AppsFilter, connected: HostedConnections | null): boolean {
  const matches = !search || `${app.label} ${app.keywords} ${t(app.description)}`.toLowerCase().includes(search.toLowerCase().trim());
  return matches && (filter === "all" || (filter === "connected" && connected?.[app.id] !== false));
}

export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

export function connectorSetupNotice(state: {
  configured: boolean;
  stale: boolean;
  setup: ConnectorSetup | undefined;
  remoteClient: boolean;
}): { key: LocaleKey; tone: "info" | "warning" } | null {
  if (state.configured || state.stale) return null;
  if (state.setup === "needs-setup") {
    return { key: state.remoteClient ? "connectors.setupNeededRemote" : "connectors.setupNeeded", tone: "info" };
  }
  return { key: "connectors.notConfigured", tone: "warning" };
}

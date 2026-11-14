import { CreditCard, Mail, MapPin, PhoneCall, Plane, RadioTower, Smartphone, type LucideIcon } from "lucide-react";

import whopLogo from "@/assets/whop/logo.png";
import type { LocaleKey } from "@/locales";
import { POSTIZ_SERVER } from "../../shared/postiz";

export interface HostedMcpApp {
  /** The card's id (`data-app-tile`) and the name the server is added under (then `-2`, `-3`…): a valid server name. */
  readonly id: string;
  /** The service's own name, never translated. */
  readonly label: string;
  /** Its official hosted MCP endpoint. A server is this app only at exactly this address, over streamable HTTP. */
  readonly url: string;
  /** The older SSE transport instead of streamable HTTP. */
  readonly transport?: "sse";
  /** A service with no browser sign-in takes a key the person pastes, sent as `Authorization: Bearer`; `url` is where
   * they make one. Without it the card signs in with browser OAuth. `placement: "query"` services take the key as a
   * URL parameter named `param`, saved as a `vault:<id>` pointer instead of a header. */
  readonly key?: { readonly url: string; readonly placement?: "header" | "query"; readonly param?: string };
  /** Its licensed logo, or a neutral lucide glyph when the service publishes none we may ship. */
  readonly icon: { readonly image: string } | { readonly glyph: LucideIcon };
  readonly description: LocaleKey;
  /** What signing in grants, and who owns the service's own approvals. Shown on the card and on the server's row. */
  readonly notice: LocaleKey;
  /** Search words besides the label and the description. */
  readonly keywords: string;
}

/** The hosted MCP apps with a one-click card in Plugins. Adding one is adding a row: its card, Connect, Disconnect and
 * Bot access, its row in the MCP list, search, the Connected filter and the count all derive from this table. */
export const HOSTED_MCP_APPS = [
  {
    id: "whop",
    label: "Whop",
    url: "https://mcp.whop.com/mcp",
    icon: { image: whopLogo },
    description: "whop.description",
    notice: "whop.notice",
    keywords: "whop checkout memberships",
  },
  {
    id: "agentcard",
    label: "Agentcard",
    url: "https://mcp.agentcard.sh/mcp",
    // Agentcard's packages are "SEE LICENSE IN LICENSE" and it publishes no logo licence, so a neutral glyph stands in.
    icon: { glyph: CreditCard },
    description: "agentcard.description",
    notice: "agentcard.notice",
    keywords: "agentcard agent card opencommerce shopping payments buy virtual debit card",
  },
  // None of these four publishes a logo licence we have checked, so neutral glyphs stand in.
  {
    id: "agentmail",
    label: "AgentMail",
    url: "https://mcp.agentmail.to/mcp",
    icon: { glyph: Mail },
    description: "agentmail.description",
    notice: "agentmail.notice",
    keywords: "agentmail email inbox mail address send reply",
  },
  {
    id: "vapi",
    label: "Vapi",
    url: "https://mcp.vapi.ai/mcp",
    key: { url: "https://dashboard.vapi.ai" },
    icon: { glyph: PhoneCall },
    description: "vapi.description",
    notice: "vapi.notice",
    keywords: "vapi phone call calls voice dial assistant",
  },
  {
    id: "telnyx",
    label: "Telnyx",
    url: "https://api.telnyx.com/v2/mcp",
    key: { url: "https://portal.telnyx.com/#/api-keys" },
    icon: { glyph: RadioTower },
    description: "telnyx.description",
    notice: "telnyx.notice",
    keywords: "telnyx phone number numbers sms text call calls international",
  },
  {
    id: "agentphone",
    label: "AgentPhone",
    url: "https://mcp.agentphone.ai/mcp",
    icon: { glyph: Smartphone },
    description: "agentphone.description",
    notice: "agentphone.notice",
    keywords: "agentphone phone number sms text call calls",
  },
  {
    id: "tencent-map",
    label: "腾讯地图",
    transport: "sse",
    url: "https://mcp.map.qq.com/sse?format=0",
    key: { url: "https://lbs.qq.com/dev/console/quick-register", placement: "query", param: "key" },
    icon: { glyph: MapPin },
    description: "tencentMap.description",
    notice: "tencentMap.notice",
    keywords: "tencent map 腾讯地图 地图 位置 地点 餐厅 路线 poi address route place",
  },
  {
    id: "variflight",
    label: "飞常准",
    url: "https://c-gw.variflight.com/chat_message/mcp/api/legacy",
    key: { url: "https://cmcp.variflight.com/" },
    icon: { glyph: Plane },
    description: "variflight.description",
    notice: "variflight.notice",
    keywords: "variflight 飞常准 航班 飞机 航班动态 机票 flight flights airline",
  },
] as const satisfies readonly HostedMcpApp[];

/** A row of the table, with its own literal id. */
export type HostedApp = (typeof HOSTED_MCP_APPS)[number];
export type HostedMcpAppId = HostedApp["id"];

export type HostedConnections = Readonly<Record<HostedMcpAppId, boolean>>;

interface ServerAddress { type?: string; url?: string }

/** The hosted app this server is, by exact address: https, the app's origin, its path with or without a trailing
 * slash, the transport it declares, no hash or userinfo, and only the app's own query parameters — plus at most the
 * key parameter a `placement: "query"` app takes. A look-alike host or a URL carrying other secrets is never branded. */
export function hostedMcpApp(server: ServerAddress): HostedApp | undefined {
  const type = server.type ?? "http";
  if (!server.url) return undefined;
  let address: URL;
  try { address = new URL(server.url); } catch { return undefined; }
  if (address.hash || address.username || address.password) return undefined;
  return HOSTED_MCP_APPS.find((app) => {
    if (type !== ("transport" in app ? app.transport : "http")) return false;
    const own = new URL(app.url);
    if (address.origin !== own.origin) return false;
    if (address.pathname !== own.pathname && address.pathname !== `${own.pathname}/`) return false;
    const keyParam = "key" in app && "placement" in app.key && app.key.placement === "query" ? app.key.param : undefined;
    const extra = [...address.searchParams.keys()].filter((name) => name !== keyParam);
    if (extra.length !== own.searchParams.size) return false;
    return extra.every((name) => address.searchParams.get(name) === own.searchParams.get(name));
  });
}

/** `whop`, then `whop-2`, `whop-3`…: never an existing server's name. */
export function hostedServerName(app: HostedMcpApp, servers: ReadonlyArray<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name: string = app.id;
  for (let suffix = 2; names.has(name); suffix++) name = `${app.id}-${suffix}`;
  return name;
}

export const HOSTED_KEY_HEADER = "Authorization";

/** The one rule for "connected", shared by the cards, the Connected filter and the count: the server is on and signed
 * in, or for a key app, on and holding its key. */
export function hostedConnections(
  servers: ReadonlyArray<ServerAddress & { enabled: boolean; auth?: "signed-in" | "needs-sign-in"; headerKeys?: readonly string[] }>,
): HostedConnections {
  const holdsKey = (app: HostedApp, server: (typeof servers)[number]) => {
    if ("key" in app && "placement" in app.key && app.key.placement === "query") {
      try { return Boolean(server.url && new URL(server.url).searchParams.get(app.key.param ?? "")); } catch { return false; }
    }
    return server.headerKeys?.some((name) => name.toLowerCase() === HOSTED_KEY_HEADER.toLowerCase()) === true;
  };
  return Object.fromEntries(HOSTED_MCP_APPS.map((app) => [
    app.id,
    servers.some((server) => hostedMcpApp(server) === app && server.enabled && ("key" in app ? holdsKey(app, server) : server.auth === "signed-in")),
  ])) as HostedConnections;
}

/** A server of the person's own: a hosted app's, and Postiz's, show as their own cards instead. */
export function ownMcpServer(server: ServerAddress & { name: string }): boolean {
  return server.url === undefined || !(hostedMcpApp(server) || server.name === POSTIZ_SERVER);
}

/** The one rule for "connected" for such a server: on, and signed in if it takes a sign-in. */
export function mcpServerConnected(server: { enabled: boolean; auth?: "signed-in" | "needs-sign-in" }): boolean {
  return server.enabled && server.auth !== "needs-sign-in";
}

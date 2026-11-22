import { CalendarClock, Cloud, Code2, MapPin, Megaphone, MessageSquare, Newspaper, Plane, Play, Send, TrainFront, type LucideIcon } from "lucide-react";

import type { LocaleKey } from "@/locales";

/** How a service takes its key: a URL parameter saved as a `vault:<id>` pointer, or an `Authorization: Bearer` header. */
export type CnMcpAuth =
  | { readonly kind: "none" }
  | { readonly kind: "query"; readonly param: string; readonly keyUrl: string }
  | { readonly kind: "header"; readonly header: string; readonly keyUrl: string; readonly prefix?: string };

export interface CnMcpApp {
  /** The card's id and the server's name (then `-2`, `-3`…): a valid MCP server name. */
  readonly id: string;
  /** The service's own name, never translated. */
  readonly label: string;
  /** Its address, exactly as the service publishes it. */
  readonly url: string;
  /** SSE instead of streamable HTTP. */
  readonly transport?: "sse";
  readonly auth: CnMcpAuth;
  /** Its licensed logo, or a neutral glyph. */
  readonly icon: { readonly image: string } | { readonly glyph: LucideIcon };
  readonly description: LocaleKey;
  /** What connecting grants, and who owns the service's own approvals. */
  readonly notice: LocaleKey;
  /** Search words besides the label and the description. */
  readonly keywords: string;
  /** What it is for, as the page groups them. */
  readonly group: "life" | "social" | "work" | "dev";
}

/** The Chinese services with a documented, directly connectable MCP address, each checked from this app on 2026-11-22:
 * an `initialize` and a `tools/list` answered, and where the service needs no key, a `tools/call` returned real data. */
export const CN_MCP_APPS = [
  {
    id: "cn-12306",
    label: "12306 火车票",
    url: "https://mcp.pianam.cn/train-mcp/mcp",
    auth: { kind: "none" },
    icon: { glyph: TrainFront },
    description: "cn12306.description",
    notice: "cn12306.notice",
    keywords: "12306 火车 高铁 车票 余票 时刻表 train railway ticket china",
    group: "life",
  },
  {
    id: "cn-calendar",
    label: "pianam 日历",
    url: "https://mcp.pianam.cn/calendar-mcp/mcp",
    auth: { kind: "none" },
    icon: { glyph: CalendarClock },
    description: "cnCalendar.description",
    notice: "cnCalendar.notice",
    keywords: "pianam 日历 日程 会议 calendar schedule",
    group: "work",
  },
  {
    id: "cn-weibo",
    label: "微博",
    url: "https://mcp.52choujiang.com/weibo/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: Megaphone },
    description: "cnWeibo.description",
    notice: "cnWeibo.notice",
    keywords: "weibo 微博 热搜 微博搜索 话题 social",
    group: "social",
  },
  {
    id: "cn-zhihu",
    label: "知乎",
    url: "https://mcp.socialdatax.com/zhihu/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: MessageSquare },
    description: "cnZhihu.description",
    notice: "cnZhihu.notice",
    keywords: "zhihu 知乎 热榜 问答 q&a",
    group: "social",
  },
  {
    id: "cn-bilibili",
    label: "哔哩哔哩",
    url: "https://mcp.socialdatax.com/bilibili/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: Play },
    description: "cnBilibili.description",
    notice: "cnBilibili.notice",
    keywords: "bilibili 哔哩哔哩 B站 视频 弹幕 video",
    group: "social",
  },
  {
    id: "cn-douyin",
    label: "抖音",
    url: "https://mcp.52choujiang.com/douyin/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: Play },
    description: "cnDouyin.description",
    notice: "cnDouyin.notice",
    keywords: "douyin 抖音 短视频 热点 video",
    group: "social",
  },
  {
    id: "cn-wechat-channels",
    label: "微信视频号",
    url: "https://mcp.52choujiang.com/wechat/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: Play },
    description: "cnWechatChannels.description",
    notice: "cnWechatChannels.notice",
    keywords: "wechat 微信 视频号 公众号 channels",
    group: "social",
  },
  {
    id: "cn-tieba",
    label: "百度贴吧",
    url: "https://mcp.socialdatax.com/baidu-tieba/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://socialdatax.com" },
    icon: { glyph: MessageSquare },
    description: "cnTieba.description",
    notice: "cnTieba.notice",
    keywords: "baidu 百度 贴吧 tieba 论坛 forum",
    group: "social",
  },
  {
    id: "cn-wechat-publisher",
    label: "公众号发布",
    url: "https://mcp.redcao.com/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://mcp.redcao.com" },
    icon: { glyph: Send },
    description: "cnWechatPublisher.description",
    notice: "cnWechatPublisher.notice",
    keywords: "wechat 微信公众号 草稿 发布 排版 publish draft",
    group: "work",
  },
  {
    id: "cn-cloudbase",
    label: "腾讯 CloudBase",
    url: "https://tcb-api.cloud.tencent.com/mcp/v1",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://console.cloud.tencent.com/tcb" },
    icon: { glyph: Cloud },
    description: "cnCloudbase.description",
    notice: "cnCloudbase.notice",
    keywords: "tencent 腾讯云 cloudbase 云开发 数据库 云函数 database functions",
    group: "dev",
  },
  {
    id: "cn-amap",
    label: "高德地图",
    url: "https://mcp.amap.com/mcp",
    auth: { kind: "query", param: "key", keyUrl: "https://lbs.amap.com/dev/console/quick-register" },
    icon: { glyph: MapPin },
    description: "cnAmap.description",
    notice: "cnAmap.notice",
    keywords: "amap 高德 地图 位置 路线 导航 天气 map location route",
    group: "life",
  },
  {
    id: "cn-didi",
    label: "滴滴出行",
    url: "https://mcp.didichuxing.com/mcp-servers",
    auth: { kind: "query", param: "key", keyUrl: "https://mcp.didichuxing.com/api" },
    icon: { glyph: MapPin },
    description: "cnDidi.description",
    notice: "cnDidi.notice",
    keywords: "didi 滴滴 打车 出行 路线 taxi ride",
    group: "life",
  },
  {
    id: "cn-gitee",
    label: "Gitee",
    url: "https://api.gitee.com/mcp",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://gitee.com/profile/personal_access_tokens" },
    icon: { glyph: Code2 },
    description: "cnGitee.description",
    notice: "cnGitee.notice",
    keywords: "gitee 码云 仓库 issue pull request 代码 git repository",
    group: "dev",
  },
  {
    id: "cn-variflight",
    label: "飞常准",
    url: "https://c-gw.variflight.com/chat_message/mcp/api/legacy",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://cmcp.variflight.com/" },
    icon: { glyph: Plane },
    description: "cnVariflight.description",
    notice: "cnVariflight.notice",
    keywords: "variflight 飞常准 航班 飞机 机票 flight",
    group: "life",
  },
  {
    id: "cn-tencent-map",
    label: "腾讯地图",
    transport: "sse",
    url: "https://mcp.map.qq.com/sse?format=0",
    auth: { kind: "query", param: "key", keyUrl: "https://lbs.qq.com/dev/console/quick-register" },
    icon: { glyph: MapPin },
    description: "cnTencentMap.description",
    notice: "cnTencentMap.notice",
    keywords: "tencent 腾讯 地图 位置 路线 map location route",
    group: "life",
  },
  {
    id: "cn-baidu-map",
    label: "百度地图",
    url: "https://mcp.map.baidu.com/mcp",
    auth: { kind: "query", param: "ak", keyUrl: "https://lbsyun.baidu.com/apiconsole/key" },
    icon: { glyph: MapPin },
    description: "cnBaiduMap.description",
    notice: "cnBaiduMap.notice",
    keywords: "baidu 百度 地图 位置 路线 路况 map location route traffic",
    group: "life",
  },
  {
    id: "cn-zhipu-search",
    label: "智谱搜索",
    url: "https://open.bigmodel.cn/api/mcp/web_search/sse",
    auth: { kind: "header", header: "Authorization", prefix: "Bearer", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
    icon: { glyph: Newspaper },
    description: "cnZhipuSearch.description",
    notice: "cnZhipuSearch.notice",
    keywords: "zhipu 智谱 搜索 web search 联网",
    group: "life",
  },
] as const satisfies readonly CnMcpApp[];

export type CnMcpAppEntry = (typeof CN_MCP_APPS)[number];
export type CnMcpAppId = CnMcpAppEntry["id"];

/** The address a service is connected at, key parameter included when it takes one there. A `vault:<id>` pointer stands
 * in for the key, so config.json never holds it. */
export function cnMcpUrl(app: CnMcpApp, keyPointer?: string): string {
  if (app.auth.kind !== "query" || !keyPointer) return app.url;
  const separator = app.url.includes("?") ? "&" : "?";
  return `${app.url}${separator}${app.auth.param}=${keyPointer}`;
}

/** The headers a service is connected with: its key as a `vault:<id>` pointer, or none when it takes no key. */
export function cnMcpHeaders(app: CnMcpApp, keyPointer?: string): Record<string, string> {
  if (app.auth.kind !== "header" || !keyPointer) return {};
  const prefix = "prefix" in app.auth && app.auth.prefix ? `${app.auth.prefix} ` : "";
  return { [app.auth.header]: `${prefix}${keyPointer}` };
}

/** Whether this address is the service's own, so its card shows the connection instead of a separate row: https, the
 * service's origin, its path, the transport it declares, and no query beyond the key parameter a query service takes. */
export function isCnMcpAddress(app: CnMcpApp, server: { type?: string; url?: string }): boolean {
  const type = server.type ?? "http";
  if (!server.url) return false;
  if (type !== ("transport" in app ? app.transport : "http")) return false;
  let address: URL;
  let own: URL;
  try {
    address = new URL(server.url);
    own = new URL(app.url);
  } catch {
    return false;
  }
  if (address.hash || address.username || address.password) return false;
  if (address.origin !== own.origin) return false;
  if (address.pathname !== own.pathname && address.pathname !== `${own.pathname}/`) return false;
  const keyParam = app.auth.kind === "query" ? app.auth.param : undefined;
  const extra = [...address.searchParams.keys()].filter((name) => name !== keyParam);
  if (extra.length !== own.searchParams.size) return false;
  return extra.every((name) => address.searchParams.get(name) === own.searchParams.get(name));
}

/** `cn-12306`, then `cn-12306-2`, `cn-12306-3`…: never an existing server's name. */
export function cnMcpServerName(app: { id: string }, servers: ReadonlyArray<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name: string = app.id;
  for (let suffix = 2; names.has(name); suffix++) name = `${app.id}-${suffix}`;
  return name;
}

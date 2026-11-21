# Grok Bot connector-link 移植

2026-11-22 · `feat/grok-connector-link`（基于合并后 main `f3b51bafbb`）

## 背景与需求

审计中曾判跳上游 Grok connector-link（`186fae7050`/`ca8c34dd41` 链），理由是「依赖隧道架构、静态导入已够」。
用户确认**确有 Grok Bot 用户迁移需求**，重新评估后发现 fork 已具备全部基建
（`managed-companion-tunnel`/`managed-companion-guardian` 的 cloudflared 管理与 `minimalCloudflaredEnvironment`），
缺的只是功能本体，判为可摘。

## 功能

Grok Bot 云端实例经 quick tunnel 反向连入桌面 app，把 Bot 的导出文档推给 LunaBot：

1. 对话框「Connect Grok Bot」区：Get the link → 复制 tunnel 地址；
2. 在 Grok Bot 侧把该地址加为自定义 connector（MCP），添加上游发布的 MausBot bot；
3. 用户让 bot move：bot 调 `send_export` 经隧道把 Bot 导出文档送达；
4. 对话框 3s 轮询列出到达的 Bot，并入与「拖文件」相同的预览/导入流程；
5. 链路生命周期：DELETE 结束 / 一小时过期 / 进程退出；到达内容在链路停后仍可读。

## 移植切片（按 upstream tip 形态，非逐提交）

上游 tip 已无 `grok-link.ts`/`grok-assets.ts`（后续重构整合），index.ts 也无 `grokHost`/`grokAssets` 线缆。
本次切片 = connector-link 本体；pages/files 资产搬运（`send_page`/`send_file`）不在 tip 形态内，不摘。

| 件 | 来源 |
| --- | --- |
| `server/grok-move-mcp.ts` + 测试 | upstream tip 原样；`productName()` 使 serverInfo/话术跟随 fork 品牌（Luna Bot） |
| `server/grok-move-tunnel.ts` + 测试 | upstream tip 原样；依赖 `resolveCloudflaredBinary`+`minimalCloudflaredEnvironment`（均在） |
| `electron/managed-companion-guardian.d.mts` | upstream tip 原样（fork 此前无此声明文件） |
| `server/routes/setup-import.ts` | +`GROK_CONNECTOR_PATH` GET/POST/DELETE 块、`grokMove` dep；仅 loopback+本地 |
| `server/brand.ts` | +`productName()`（缺省返回 `DEFAULT_BRAND.name`） |
| `shared/grok-import.ts` | +`grokExportDocument()`（MCP 侧写文档用） |
| `src/lib/grok-move.ts` + 测试 | upstream tip 原样：`GrokConnector`/`grokConnector()`/`MAUSBOT_GROK_TEMPLATE_URL` |
| `src/components/GrokMoveDialog.tsx` + 测试 | upstream tip 原样 + Connect 区 |
| `en.json` + zh/zh-tw/ja/pt-br | +11 个 `grokMove.connect.*` 键 |

## 关键判定

- **品牌**：`serverInfo`/`Connected to X`/`while X stays open` 等指**本 app** 处 → Luna Bot（`productName`/`DEFAULT_BRAND.name`）；
  `name it MausBot`/`Add the MausBot bot`/`MAUSBOT_GROK_TEMPLATE_URL` 指 **x.ai 上游已发布的模板 bot** → 保持 MausBot，
  用户按指令在 Grok Bot 里找到的实物即此名。fork 未来若发布自有模板 bot 再换 URL。
- **安全面原样**：keyed path `timingSafeEqual`、POST+JSON only、4MB 请求体、100 文档/16MB inbox、
  connector 端点仅 loopback（`auth.kind !== "loopback" || trust === "service"` → 403）、cloudflared PATH-only 环境+独立 config。
- **fork 适配**：上游测试里 `SettingsLook.Provider`/`data-settings-block` 是上游设置窗基建（fork 无），
  测试断言改按 fork 的 `data-import-section` plain section；`everyday-words` ALLOWED 补 `connect.where`（"Server URL" 是 Grok Bot 表单字段名）。

## 验证

- `pnpm typecheck` 绿
- 定向：mcp 6 + tunnel 3 + setup-import 19 + lib 9 + dialog 17 = **54/54**；`src/locales/` 15 文件过
- `pnpm i18n:check` 绿（zh 100%）；oxlint 净
- tunnel 测试含真实 loopback listener 端到端（POST→inbox→look→end）

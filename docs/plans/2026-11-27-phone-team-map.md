# 手机端团队地图只读页（批次C）

## 背景与范围

审计「手机全协议 parity」一节指出：桌面端用 team-map / usage / activity，
Android 无封装。逐条评估结论：

- **team-map**：`GET /api/team-map` 早在 companion 白名单（只读观测面，
  信任边界允许），但 Android 没有页面——**本批补**。
- **activity**：`GET /api/bots/:id/activity` 已有 `BotActivityScreen`（PR #105）——已覆盖。
- **usage / usage-traces**：不在 companion 白名单，是重分析桌面面；
  手机端**有意不补**——若将来需要，应先讨论白名单扩张而非偷偷加页。

## team-map 页设计

- 纯只读：协作 DM 列表（两两直聊）、排队中委派、进行中委派，三区展示。
- team-map 本来就没有写路由，只读不是妥协，是协议本身。
- null（电脑拒答/太旧/够不到）画一行说明，沿用 BotActivityScreen/BotMcpServersScreen 先例。
- 入口：设置 → 工作区 → 团队地图（与会话与例程/通知同区）。
- bot 名从 session state 解析，解析不到回退裸 id。

## 验证

- `:core:compileKotlin` / `:app:compileDebugKotlin` 绿
- core 路由断言（ClientTest 白名单扫描覆盖新增 GET）

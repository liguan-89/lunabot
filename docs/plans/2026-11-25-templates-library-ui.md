# Plan: 本地模板库桌面 UI（半成品排查批次3）

## Why

`server/routes/templates.ts` 是完整的本地模板库 CRUD（DATA_DIR/templates 下的
package 文档存取，list/save/read/delete），server/index.ts 已注册路由，
但桌面端零调用——模板库是「后端做了、产品 UI 未接」的纯半成品。
用户拍板补 UI 而非拆 API。

## 闭环设计

模板 = package 文档（与分享/导入同一格式）。三个动作补全闭环：

1. **列表+安装+删除**：TeamLibraryPanel 顶部加「我的模板」区（远程目录之上）。
   - 列表 `GET /api/templates`（slug/savedAt/summary：bot 数、分区等）
   - 安装：`GET /api/templates/:slug` 取文档 → 走现有
     `POST /api/teams/import?mode=add`（与目录安装同一链路，重名/冲突处理白得）
   - 删除：`DELETE /api/templates/:slug`，二次确认
2. **存为模板**：ShareTeamDialog 已经用 `/api/teams/export` 产出 package
   文档做预览/分享。在对话框加第三动作「存入模板库」：
   `POST /api/templates {document, name?}`。分享与存模板同源同事，
   不新增导出通道。

## 不做

- 不改模板存储格式/路由（后端已完整）
- 不做模板编辑、版本管理、远程同步
- 手机端不接（companion 白名单未放行 /api/templates，桌面功能先行）

## 验证

- 定向 vitest：TeamLibraryPanel/ShareTeamDialog 同目录测试更新
- T1：typecheck + i18n:check（新增 locale 键）+ oxlint
- 隔离 fixture 手动验证（verify-omb 手册）：存模板→列表出现→安装→删除

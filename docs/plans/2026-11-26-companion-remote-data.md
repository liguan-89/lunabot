# 桌面 companion 远程 Data 只读查看

日期：2026-11-26
状态：实现中

## 背景

桌面远程模式（`window.ogb.remoteClient.active`）下，`DataResultChip` 直接禁用
「在『数据』中打开」按钮，文案称「通过伴侣连接时暂不支持查看数据」。

审计发现这是半成品而非刻意边界：

- companion 白名单**已放行**只读 data 路由（批次5为手机端放行）：
  `GET /api/bots/:id/data`（sheet）、`POST /data/page`（翻页）、
  `GET /data/cards/:cid/image`（图表图片）；
- 查看链路 `loadDataSheet` → `DATA_ROUTES.sheet`、DataGrid 翻页 →
  `DATA_ROUTES.page` 全部是这三个路由；
- 桌面远程模式与手机走**同一个** companion 白名单代理（证据：store.tsx 里
  webhooks 在 remoteClient.active 时被跳过，因为不在白名单）。

## 范围

**做**：远程模式下 Data 只读查看，与手机端体验一致。

1. `DataResultChip` 解禁：删除 companion 禁用逻辑与 `data.openInWorkspace`
   文案（zh/en/source-hashes 三处）。
2. `DataPanel` 远程只读化：SQL 编辑器只读、不触发 `run`/`cancel`
   （这两路由刻意不在白名单——「Running SQL stays on the host」，SQL 可写库）；
   编辑器旁显示只读提示。
3. `DataCard` 远程隐藏导出菜单（`export` 写主机文件系统，不在白名单）。

**不做**（刻意边界，非半成品）：

- live SQL 执行（`run`/`cancel`）——任意 SQL 可写库，留在主机；
- 导出（`export`）——写主机文件系统；
- 新建/编辑/删除卡片——写操作。

## 验收

- `pnpm typecheck` 绿；
- `pnpm exec vitest run src/components/data src/state/data-sheets.test.ts` 绿；
- `pnpm exec oxlint --deny-warnings <改动文件>` 绿；
- `pnpm i18n:check` 绿（动了 locale）；
- 远程模式界面：数据芯片可点开 Data 面板、翻页看图表；SQL 区只读带提示；
  无导出按钮。

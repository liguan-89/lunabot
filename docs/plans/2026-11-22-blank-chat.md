# 空白聊天（首条发送才建会话）——fork 等价移植设计

来源：上游 `21ed317d41` + `afbff51b7c`（OpenMausBot v0.1.175 窗口）。审计期因
依赖链判定跳过的最大单项，现按上游思路在 fork 架构上重实现。

## 目标行为

- 「新会话」入口（侧栏 + 菜单/New chat/机器人 +/文件夹 +/Cmd+Shift+N/命令面板/置顶圈）
  不再立即 `POST /api/bots/:id/tasks`，而是打开一个**空白会话**（`state.newChat`）。
- 空白会话对该 bot 复用：同 bot 再点「新会话」回到同一空白会话，未发送文本保留
  （fork 草稿键 `bot:<id>:<threadId>`，合成 threadId `new-chat-<bot>` 天然分桶）。
- 第一条 `send` 才真正建会话；建好后把消息发进去。并发的覆盖性发送（建议卡片/
  通话回合）同样路由进空白会话。
- 空白会话期内可选模型/思考（`setModel`/`updateTask` 记 `held`，建会话后重放）。
- 离开未发送不留任何东西（服务端零调用）。
- 带 cwd 的 `newTask`（工作文件夹对话框）维持即时建会话。

## fork 适配点（与上游差异）

| 上游 | fork | 处理 |
| --- | --- | --- |
| `useBotListDrawer` 收起抽屉 | 无该模块 | 跳过（`navigated` 仍保留） |
| `removeForkOptimistic` | 无 | 不需要 |
| LEAVING 含 `showPublishedApps`/`showTeamFiles`/`showAnnouncements` | Action 无此三型 | 从集合去掉 |
| `main[data-look="chat"]` 聚焦选择器 | ChatView main 无 `data-look`；composer 有 `data-tour="composer"` | 选择器改 `[data-tour="composer"] textarea` |
| `sidebar-state.ts` 选择器 | 无此文件；`botRowProps` 拿整 `AppState` | `drafting` 直接进 `botRowProps` |
| `store-select` 的 `useStoreSelector` | 存在（`src/state/store-select.ts`） | 沿用 |

## 落地清单

1. `src/state/new-chat.ts`：`NewChat`/`newChatThreadId`/`isNewChatThread`/
   `reduceNewChat`/`newChatBot`/`createNewChat`/`focusComposer`。
2. `store.tsx`：`AppState.newChat?`、`newTask.blankChat?`、`reduceApp` 首部接
   `reduceNewChat`、StoreProvider 内 `createNewChat`（`create` = flush + POST
   `/api/bots/:id/tasks`）、dispatch 包装器 `runNewChat` 拦截。
3. `App.tsx`：`chatBot = newChatBot(bot, state.newChat)` 传 ChatView。
4. `ChatView`：`privateChat` 加 `isNewChatThread(bot.threadId)`（团队下空白会话
   视为私人会话）。
5. `CallView`：`liveThreadId` 排除 `new-chat-*`（通话回合路由进空白会话）。
6. `SidebarBotList`：`botRowProps` 加 `drafting`；`BotThreadList` 行 `current`
   去 `drafting`（旧会话行不再标当前）。
7. `use-presence`：presence 选择键加 `newChat.session`（开空白会话不覆盖旧会话
   presence 且能区分各空白会话）。
8. `use-read-shown-chat`：焦点回归时空白会话开着不派发 `select`（不清未读标记）。
9. `DetailsTab`（`afbff51b7c`）：Model/EffortRow 拿 `newChatBot(bot, newChat)`
   的 thread，选择记进 held。
10. `src/state/new-chat.test.ts`：合成体生命周期/held 重放/覆盖发送路由/离开清理。

## 验收

- 单测：新模块测试 + `src/state/`、`src/hooks/use-presence*`、`use-read-shown-chat*`、
  `Sidebar*` 定向测试全绿。
- `pnpm typecheck`、oxlint 净。
- 验证走隔离 fixture；不动真实数据。

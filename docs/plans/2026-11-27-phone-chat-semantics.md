# Android 聊天语义：dataResult 接 Data 页、tool 详情、归属与引用

日期：2026-11-27
状态：摸底完成，实现未开始（worktree lunabot-chat-semantics，分支 feat/phone-chat-semantics，基于 76f6eb01f5 含批次A）

## 审计缺口

1. **dataResult 丢失**：`data_show` 活动消息携带 `{botId, cardId, title, kind, sql?}`
   （server/index.ts:13668 拼装；shared/wire.ts:607），Android Message 未解码，
   聊天里只剩抽象 `data_show` 活动痕迹。Android 已有 Data 只读页
   （BotDataScreen）与卡片图接口封装（Client.kt `/data/cards/:cid/image`）。
2. **tool 活动详情**：wire 的 WireTool 有 summary/input/output/step/whose/problem/
   fullResult，Android ToolActivity（Models.kt:165）只解码 name/ok/spoken/setup/
   claudeUpdate/rescue/limitResetsAt。`/messages/:mid/tool` 详情路由已在 companion
   白名单（routes.ts:217）但客户端未用。
3. **sender/replyToId/via 归属**：多人 workspace 看不出谁说的、回谁的。
   wire: `sender: ResolvedSender{name, id?}`、`replyToId`、`via: "api"|"call"`、
   `relayed`、`turnSucceeded`、`requestCancelled`。

## 实现计划（三 commit 一 PR）

### B1 dataResult
- Models.kt：`Message.dataResult` 数据类（botId/cardId/title/kind/sql?）
- MessageRow ACTIVITY 分支：`tool.name == "data_show"` 且有 dataResult 时渲染
  可点芯片（图标+标题）；点击导航 `Destination.BotData(botId)`
- BotDataScreen 加 `initialCardId` 参数：加载后自动选中该卡片进浏览态
  （browsing 初值）；Destination.BotData 加可选 cardId
- ChatScreen 需要 onOpenData 导航回调——查 RootScreen 541 行 onOpenData 怎么传
  进 ChatScreen（现状 ChatScreen 没有该回调，需要穿透）
- chart 类型可在芯片内用卡片图接口画预览 PNG（可选增强，B1 可只做跳转）

### B2 tool 详情
- ToolActivity 解码补：summary/input/output/problem/step/whose（wire 核对字段名）
- ActivityChip 点击展开详情 bottom sheet：显示已解码字段
- Client.kt 封装 `GET /api/bots/:id/messages/:mid/tool` 取 fullResult（白名单已放行）
- 详情 sheet 里按需加载 fullResult

### B3 sender/replyToId/via
- Message 解码 sender/replyToId/via/relayed
- TextBubble：多人 workspace（workspace 有多人——怎么判定？查 state）或
  relayed/via 非空时在气泡上方小字显示发送者/来源标记
- replyToId：气泡上方画引用预览条（被引用消息的 text 摘要，从 transcript 查）
- via=call 显示「语音来电」标记

## 验收
- core/app 单元测试 + 编译绿
- 模拟器验证：data_show 芯片跳转 Data 页定位卡片；多人会话归属显示

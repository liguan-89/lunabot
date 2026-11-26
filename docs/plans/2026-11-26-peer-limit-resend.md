# Plan: peer-limit-resend 接线（半成品排查批次4）

## Why

`server/host/peer-limit-resend.ts` 是完整移植的上游模块（221 行+184 行测试）：
bot-to-bot 委派/转交回合如果在任何东西运行前撞额度，转到备用 AI 重试一次，
保留原始权限、来源和交接语义。但 fork 生产零接线——周边设施
（directFollowupTurns/directCoordinationSettlers/limitTakeover/coordinator）
全部已移植，唯独这个模块的六个接线点被漏掉了。用户拍板接线恢复功能。

## 方案：对照 upstream/main 逐点移植

上游 `server/index.ts` 有完整接线（已核对 fork 每个锚点结构同构）：

1. import `createPeerLimitResend`
2. `settleDirectCoordination` 开头加 hold 检查：重发 pending 时扣住失败结局
3. watchdog.start() 行尾实例化（沿上游单行风格，不占棘轮行数）
4. turn.completed：owner 存在先 `ended()` 再 settle；无 owner `endedUnbound()`
5. settleDirectTurn 两处 `resend()`（stale 代际与 continueComputerSelection 旁路）
6. dispatch 处 `track()`（recoveryUserMessageId 已在作用域）
7. 早完成绑定处 `bound()`
8. locales 加 `server.peerResend.failed`（en 原文照上游，zh 翻译）

**唯一语义偏差**：上游 `blocked` 用 `botHolds.held(botId)`（手动挂起功能），
fork 无此功能（bot-holds 模块不存在）；用 fork 对应物
`starterAwake.isPaused(botId)` 顶替「用户暂停的 bot 不被重发踩过」语义。

## 验证

- typecheck + oxlint + i18n:check
- 定向 vitest：peer-limit-resend.test.ts 原有 184 行测试 + direct-followup/
  coordination 相关测试文件回归
- verify-omb 隔离 fixture：造假引擎首轮撞限额，验证委派回合自动落备用 AI
